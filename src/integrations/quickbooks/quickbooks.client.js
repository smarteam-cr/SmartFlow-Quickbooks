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
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;
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
    const query = `SELECT * FROM Customer WHERE DisplayName = '${displayName}'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const customerInfo = response.data.QueryResponse.Customer;
    return (customerInfo && customerInfo.length > 0) ? customerInfo[0] : null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando cliente por DisplayName: ${detail}`);
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
 * Obtiene todas las tasas de impuesto (TaxRate) del QuickBooks del cliente.
 * Cada TaxRate tiene: Id, Name, RateValue (el porcentaje, ej: 13).
 */
async function getTaxRates() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const query = 'SELECT * FROM TaxRate';
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    return response.data.QueryResponse.TaxRate || [];
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo TaxRates de QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Obtiene todos los códigos de impuesto (TaxCode) del QuickBooks del cliente.
 * Cada TaxCode tiene: Id, Name, y referencia a los TaxRates que lo componen.
 */
async function getTaxCodes() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const query = 'SELECT * FROM TaxCode';
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    return response.data.QueryResponse.TaxCode || [];
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo TaxCodes de QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

/**
 * Obtiene todas las cuentas de ingreso (Account tipo Income) del QuickBooks del cliente.
 * Útil para descubrir automáticamente el incomeAccountId durante onboarding.
 */
async function getIncomeAccounts() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const query = "SELECT * FROM Account WHERE AccountType = 'Income'";
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    return response.data.QueryResponse.Account || [];
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error obteniendo cuentas de ingreso de QuickBooks: ${detail}`);
    throw new Error(detail);
  }
}

module.exports = {
  qbClient,
  getPaymentDetails,
  findCustomerByEmail,
  createCustomer,
  findCustomerByDisplayName,
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
  getTaxRates,
  getTaxCodes,
  getIncomeAccounts,
};
