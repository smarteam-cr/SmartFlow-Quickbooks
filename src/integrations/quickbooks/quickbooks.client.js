const config = require("../../config");
const axios = require("axios");
const authService = require("../../services/auth.service");
const logger = require("../../lib/logger.lib");
const { DEFAULT_TENANT_ID } = require("../../config/constants");
const { extractAxiosError } = require("../../utils/axios.error.util");

/**
 * Instancia centralizada de Axios para QuickBooks.
 */
const qbClient = axios.create({
  baseURL: config.quickbooks.baseUrl,
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity'
  }
});

/**
 * Interceptor de Petición: Inyecta el token de acceso correspondiente al tenant.
 */
qbClient.interceptors.request.use(async (reqConfig) => {
  try {
    const token = await authService.getQuickBooksToken(DEFAULT_TENANT_ID);
    reqConfig.headers['Authorization'] = `Bearer ${token}`;
    return reqConfig;
  } catch (error) {
    return Promise.reject(error);
  }
});

/**
 * Interceptor de Respuesta: Maneja errores 401 renovando el token automáticamente.
 */
qbClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response && error.response.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        logger.info(`[QuickBooksClient] 401 Unauthorized detectado. Iniciando refresh para ${DEFAULT_TENANT_ID}...`);
        const newAccessToken = await authService.refreshQuickBooksToken(DEFAULT_TENANT_ID);
        originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`;
        return qbClient(originalRequest);
      } catch (refreshError) {
        logger.error(`[QuickBooksClient] Falló el ciclo de autorrefresco: ${extractAxiosError(refreshError)}`);
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  }
);

/**
 * Helper para obtener la configuración (Token + RealmId) y construir la URL base del recurso.
 */
async function getBaseResourceUrl() {
  const { realmId } = await authService.getQuickBooksConfig(DEFAULT_TENANT_ID);
  return `/${realmId}`;
}

async function getPaymentDetails(paymentId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/payment/${paymentId}?minorversion=65`);
    return response.data.Payment;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo detalles del pago ${paymentId}: ${detail}`);
    throw new Error(detail);
  }
}

async function findCustomerByEmail(email) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeEmail = String(email).replace(/'/g, "\\'");
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${safeEmail}'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const customerInfo = response.data.QueryResponse.Customer;
    return (customerInfo && customerInfo.length > 0) ? customerInfo[0] : null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando cliente en QuickBooks por email: ${detail}`);
    throw new Error(detail);
  }
}

async function createCustomer(customerData) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const isCompany = customerData.companyName && !customerData.firstName && !customerData.lastName;
    let displayName = customerData.displayName;

    if (!displayName) {
      if (isCompany) {
        displayName = customerData.companyName;
      } else if (customerData.parentRef && customerData.companyName) {
        const fullName = `${customerData.firstName || ""} ${customerData.lastName || ""}`.trim();
        displayName = `${fullName} (${customerData.companyName})`;
      } else {
        displayName = `${customerData.firstName || ""} ${customerData.lastName || ""}`.trim();
      }
    }

    const payload = { DisplayName: displayName };
    if (!isCompany) {
      payload.GivenName = customerData.firstName || "";
      payload.FamilyName = customerData.lastName || "";
    }
    if (customerData.companyName) payload.CompanyName = customerData.companyName;
    if (customerData.email) payload.PrimaryEmailAddr = { Address: customerData.email };
    if (customerData.phone) payload.PrimaryPhone = { FreeFormNumber: customerData.phone };
    if (customerData.mobile) payload.Mobile = { FreeFormNumber: customerData.mobile };
    if (customerData.address || customerData.city || customerData.country || customerData.state || customerData.zip) {
      payload.BillAddr = {};
      if (customerData.address) payload.BillAddr.Line1 = customerData.address;
      if (customerData.city) payload.BillAddr.City = customerData.city;
      if (customerData.country) payload.BillAddr.Country = customerData.country;
      if (customerData.state) payload.BillAddr.CountrySubDivisionCode = customerData.state;
      if (customerData.zip) payload.BillAddr.PostalCode = customerData.zip;
    }
    if (customerData.parentRef) {
      payload.ParentRef = { value: customerData.parentRef };
      payload.Job = true;
    }
    if (customerData.suffix) payload.Suffix = customerData.suffix.substring(0, 16);
    if (customerData.nit) payload.AlternatePhone = { FreeFormNumber: customerData.nit };
    if (customerData.domain) {
      let uri = customerData.domain;
      if (uri && !uri.startsWith('http')) uri = `https://${uri}`;
      payload.WebAddr = { URI: uri };
    }
    if (typeof customerData.active === 'boolean') payload.Active = customerData.active;
    if (customerData.preferredCurrency) {
      payload.CurrencyRef = { value: customerData.preferredCurrency };
    }

    const response = await qbClient.post(`${baseUrl}/customer?minorversion=65`, payload);
    return response.data.Customer;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error de validación creando cliente en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function findCustomerByDisplayName(displayName) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeName = String(displayName).replace(/'/g, "\\'");
    const query = `SELECT * FROM Customer WHERE DisplayName = '${safeName}'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const customerInfo = response.data.QueryResponse.Customer;
    return (customerInfo && customerInfo.length > 0) ? customerInfo[0] : null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando cliente por DisplayName: ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Busca un Customer en QB por Suffix (documento de identidad).
 * Se usa como dedup primario en el flujo HS→QB de contactos.
 *
 * Limitación de QB: la propiedad `Suffix` NO es queryable server-side
 * (error 4001). Estrategia: hacemos LIKE sobre DisplayName (nuestro API
 * y QB por default incluyen la cédula como sufijo del DisplayName) y
 * luego filtramos client-side por Suffix exacto para eliminar falsos
 * positivos (ej. cédula "1-1234" es substring de "1-12345").
 */
async function findCustomerBySuffix(suffix) {
  if (!suffix) return null;
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeSuffix = String(suffix)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/[%_]/g, "");
    const query = `SELECT * FROM Customer WHERE DisplayName LIKE '%${safeSuffix}%'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const candidates = response.data.QueryResponse.Customer || [];
    const exactMatch = candidates.find(c => c.Suffix === suffix);
    return exactMatch || null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando cliente por Suffix: ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Busca un Customer-empresa en QB por NIT.
 * Se usa como dedup primario en el flujo HS->QB de empresas.
 *
 * Misma estrategia que findCustomerBySuffix: QB no permite query directo
 * sobre AlternatePhone, así que hacemos LIKE sobre DisplayName (que incluye
 * el NIT como sufijo) y filtramos client-side por AlternatePhone exacto.
 */
async function findCompanyByNit(nit) {
  if (!nit) return null;
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeNit = String(nit)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/[%_]/g, "");
    const query = `SELECT * FROM Customer WHERE DisplayName LIKE '%${safeNit}%'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const candidates = response.data.QueryResponse.Customer || [];
    const exactMatch = candidates.find(c => c.AlternatePhone?.FreeFormNumber === nit);
    return exactMatch || null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando empresa por NIT: ${detail}`);
    throw new Error(detail);
  }
}

async function getAllCustomers() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const query = "SELECT * FROM Customer maxResults 3";
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    return response.data.QueryResponse.Customer || [];
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo clientes de QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function findItemByName(itemName) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeName = itemName.replace(/'/g, "\\'");
    const query = `SELECT * FROM Item WHERE Name = '${safeName}' AND Active = true`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const itemInfo = response.data.QueryResponse.Item;
    return (itemInfo && itemInfo.length > 0) ? itemInfo[0] : null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando Item por nombre: ${detail}`);
    throw new Error(detail);
  }
}

async function createItem(itemData) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.post(`${baseUrl}/item?minorversion=65`, itemData);
    return response.data.Item;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error creando Item en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function getItemById(itemId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/item/${itemId}?minorversion=65`);
    return response.data.Item;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo Item ${itemId} en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function updateItem(itemId, syncToken, itemData) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const payload = {
      Id: String(itemId),
      SyncToken: String(syncToken),
      sparse: true,
      ...itemData
    };
    const response = await qbClient.post(`${baseUrl}/item?minorversion=65`, payload);
    return response.data.Item;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error de validación actualizando Item ${itemId} en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function createInvoice(invoicePayload) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.post(`${baseUrl}/invoice?minorversion=65`, invoicePayload);
    return response.data.Invoice;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error creando Factura en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function getInvoice(invoiceId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/invoice/${invoiceId}?minorversion=65`);
    return response.data.Invoice;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo la Factura ${invoiceId}: ${detail}`);
    throw new Error(detail);
  }
}

async function getCustomerById(customerId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/customer/${customerId}?minorversion=65`);
    return response.data.Customer;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo Customer ${customerId}: ${detail}`);
    throw new Error(detail);
  }
}

async function updateCustomer(qbCustomerId, syncToken, customerData) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const isCompany = customerData.companyName && !customerData.firstName && !customerData.lastName;
    let displayName = customerData.displayName;
    if (!displayName) {
      if (isCompany) displayName = customerData.companyName;
      else if (customerData.parentRef && customerData.companyName) {
        const fullName = `${customerData.firstName || ""} ${customerData.lastName || ""}`.trim();
        displayName = `${fullName} (${customerData.companyName})`;
      } else {
        displayName = `${customerData.firstName || ""} ${customerData.lastName || ""}`.trim();
      }
    }

    const payload = {
      Id: String(qbCustomerId),
      SyncToken: String(syncToken),
      sparse: true
    };
    if (displayName) payload.DisplayName = displayName;
    if (!isCompany) {
      if (customerData.firstName) payload.GivenName = customerData.firstName;
      if (customerData.lastName) payload.FamilyName = customerData.lastName;
    }
    if (customerData.companyName) payload.CompanyName = customerData.companyName;
    if (customerData.email) payload.PrimaryEmailAddr = { Address: customerData.email };
    if (customerData.phone) payload.PrimaryPhone = { FreeFormNumber: customerData.phone };
    if (customerData.mobile) payload.Mobile = { FreeFormNumber: customerData.mobile };
    if (customerData.address || customerData.city || customerData.country || customerData.state || customerData.zip) {
      payload.BillAddr = {};
      if (customerData.address) payload.BillAddr.Line1 = customerData.address;
      if (customerData.city) payload.BillAddr.City = customerData.city;
      if (customerData.country) payload.BillAddr.Country = customerData.country;
      if (customerData.state) payload.BillAddr.CountrySubDivisionCode = customerData.state;
      if (customerData.zip) payload.BillAddr.PostalCode = customerData.zip;
    }
    if (customerData.parentRef) {
      payload.ParentRef = { value: String(customerData.parentRef) };
      payload.Job = true;
    } else if (customerData.parentRef === null) {
      payload.Job = false;
    }
    if (customerData.suffix) payload.Suffix = customerData.suffix.substring(0, 16);
    if (customerData.nit) payload.AlternatePhone = { FreeFormNumber: String(customerData.nit) };
    if (customerData.domain) {
      let uri = customerData.domain;
      if (uri && !uri.startsWith('http')) uri = `https://${uri}`;
      payload.WebAddr = { URI: uri };
    }
    if (typeof customerData.active === 'boolean') payload.Active = customerData.active;
    // customerData.preferredCurrency se ignora deliberadamente: QB no permite
    // cambiar CurrencyRef de un customer existente (rechaza el update entero).
    // El caller emite el warning si detecta divergencia con la moneda actual.

    const response = await qbClient.post(`${baseUrl}/customer?minorversion=65`, payload);
    return response.data.Customer;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error de validación actualizando cliente ${qbCustomerId} en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function updateInvoice(qbInvoiceId, syncToken, invoicePayload) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const payload = {
      Id: String(qbInvoiceId),
      SyncToken: String(syncToken),
      sparse: true,
      ...invoicePayload
    };
    const response = await qbClient.post(`${baseUrl}/invoice?minorversion=65`, payload);
    return response.data.Invoice;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error actualizando factura ${qbInvoiceId}: ${detail}`);
    throw new Error(detail);
  }
}

async function createPayment(paymentPayload) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.post(`${baseUrl}/payment?minorversion=75`, paymentPayload);
    return response.data.Payment;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error creando Pago en QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

async function findPaymentByRefNumber(refNumber) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeRef = refNumber.replace(/'/g, "\\'");
    const query = `SELECT * FROM Payment WHERE PaymentRefNum = '${safeRef}'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    return response.data.QueryResponse.Payment || [];
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando Pago por referencia ${refNumber}: ${detail}`);
    throw new Error(detail);
  }
}

async function linkPaymentToInvoice(paymentId, syncToken, qbInvoiceId, amount, customerId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const payload = {
      Id: String(paymentId),
      SyncToken: String(syncToken),
      sparse: true,
      CustomerRef: { value: String(customerId) },
      TotalAmt: Number(amount), // QB a veces exige confirmar el TotalAmt incluso en sparse updates
      Line: [
        {
          Amount: Number(amount),
          LinkedTxn: [
            {
              TxnId: String(qbInvoiceId),
              TxnType: "Invoice"
            }
          ]
        }
      ]
    };

    const response = await qbClient.post(`${baseUrl}/payment?minorversion=65`, payload);
    return response.data.Payment;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error de validación enlazando Pago ${paymentId} a Factura ${qbInvoiceId}. Detalle QB: ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Busca los últimos invoices en QB y retorna el máximo DocNumber numérico
 * con su longitud de zero-padding original. Se usa para calcular el próximo
 * DocNumber cuando el tenant tiene Custom Transaction Numbers activado y
 * QB no auto-numera por API.
 *
 * Retorna: { lastNumber: 647, paddingLength: 6 }  // para "000647"
 *          { lastNumber: 0,   paddingLength: 0 }  // si no hay invoices
 */
async function getLastInvoiceDocNumber() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const query = "SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 10";
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const invoices = response.data.QueryResponse?.Invoice || [];

    let lastNumber = 0;
    let paddingLength = 0;
    for (const inv of invoices) {
      if (!inv.DocNumber) continue;
      const n = parseInt(inv.DocNumber, 10);
      if (!isNaN(n) && n > lastNumber) {
        lastNumber = n;
        paddingLength = inv.DocNumber.length;
      }
    }
    return { lastNumber, paddingLength };
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error consultando último DocNumber de Invoice en QB: ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Lee las preferencias de la empresa en QB.
 * Útil para heredar SalesEmailCc, SalesEmailBcc y DefaultTerms al crear facturas.
 */
async function getCompanyPreferences() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/preferences?minorversion=65`);
    return response.data.Preferences;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo Preferences de la empresa en QB: ${detail}`);
    throw new Error(detail);
  }
}

module.exports = {
  qbClient,
  getPaymentDetails,
  findCustomerByEmail,
  createCustomer,
  findCustomerByDisplayName,
  findCustomerBySuffix,
  findCompanyByNit,
  getAllCustomers,
  findItemByName,
  createItem,
  getItemById,
  createInvoice,
  getInvoice,
  getCustomerById,
  updateCustomer,
  updateItem,
  updateInvoice,
  createPayment,
  findPaymentByRefNumber,
  linkPaymentToInvoice,
  getLastInvoiceDocNumber,
  getCompanyPreferences,
};
