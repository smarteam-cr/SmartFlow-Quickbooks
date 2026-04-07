const config = require("../../config");
const axios = require("axios");
const authService = require("../../services/auth.service");
const { DEFAULT_TENANT_ID } = require("../../config/constants");

/**
 * Instancia centralizada de Axios para QuickBooks.
 * Nota: El baseURL no incluye el realmId porque este variará por tenant (V2.0).
 */
const qbClient = axios.create({
  baseURL: config.quickbooks.baseUrl, // https://sandbox-quickbooks.api.intuit.com/v3/company
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity' // Evita el error "incorrect header check" forzando una respuesta sin compresión
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
 * Implementa el reintento de la petición fallida.
 */
qbClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Si recibimos un 401 y no hemos reintentado ya esta petición...
    if (error.response && error.response.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        console.log(`[QuickBooksClient] 401 Unauthorized detectado. Iniciando refresh para ${DEFAULT_TENANT_ID}...`);
        
        // Delegamos la renovación al servicio de autenticación (que tiene el Mutex)
        const newAccessToken = await authService.refreshQuickBooksToken(DEFAULT_TENANT_ID);
        
        // Actualizamos la cabecera con el nuevo token
        originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`;

        // Reintentamos la petición original
        return qbClient(originalRequest);
      } catch (refreshError) {
        console.error('[QuickBooksClient] Falló el ciclo de autorrefresco:', refreshError.message);
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
  // Dado que QB_SANDBOX_BASE_URL en el .env ya incluye /v3/company, 
  // aquí solo necesitamos agregar el realmId.
  return `/${realmId}`;
}

async function getPaymentDetails(paymentId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/payment/${paymentId}?minorversion=65`);
    return response.data.Payment;
  } catch (error) {
    throw new Error(`Error obteniendo detalles del pago ${paymentId}: ${error.message}`);
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
    console.error("Error buscando cliente en QuickBooks:", error.message);
    throw error;
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
    if (customerData.address || customerData.city || customerData.country) {
      payload.BillAddr = {};
      if (customerData.address) payload.BillAddr.Line1 = customerData.address;
      if (customerData.city) payload.BillAddr.City = customerData.city;
      if (customerData.country) payload.BillAddr.Country = customerData.country;
    }
    if (customerData.parentRef) {
      payload.ParentRef = { value: customerData.parentRef };
      payload.Job = true;
    }
    if (customerData.nit) payload.AlternatePhone = { FreeFormNumber: customerData.nit };
    if (customerData.domain) {
      let uri = customerData.domain;
      if (uri && !uri.startsWith('http')) uri = `https://${uri}`;
      payload.WebAddr = { URI: uri };
    }
    if (customerData.hsId) {
      const prefix = isCompany ? "HS_COMPANY_ID" : "HS_CONTACT_ID";
      payload.Notes = `${prefix}:${customerData.hsId}`;
    }

    const response = await qbClient.post(`${baseUrl}/customer?minorversion=65`, payload);
    return response.data.Customer;
  } catch (error) {
    console.error("Error creando cliente en QuickBooks:", error.message);
    throw error;
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
    console.error("Error buscando cliente por DisplayName:", error.message);
    throw error;
  }
}

async function getAllCustomers() {
  try {
    const baseUrl = await getBaseResourceUrl();
    const query = "SELECT * FROM Customer maxResults 3";
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    return response.data.QueryResponse.Customer || [];
  } catch (error) {
    console.error("Error obteniendo clientes de QuickBooks:", error.message);
    throw error;
  }
}

async function findItemByName(itemName) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeName = itemName.replace(/'/g, "\\'");
    const query = `SELECT * FROM Item WHERE Name = '${safeName}'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const itemInfo = response.data.QueryResponse.Item;
    return (itemInfo && itemInfo.length > 0) ? itemInfo[0] : null;
  } catch (error) {
    console.error("Error buscando Item por nombre:", error.message);
    throw error;
  }
}

async function createItem(itemData) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.post(`${baseUrl}/item?minorversion=65`, itemData);
    return response.data.Item;
  } catch (error) {
    console.error("Error creando Item en QuickBooks:", error.message);
    throw error;
  }
}

async function getItemById(itemId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/item/${itemId}?minorversion=65`);
    return response.data.Item;
  } catch (error) {
    console.error(`Error obteniendo Item ${itemId} en QuickBooks:`, error.message);
    throw error;
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
    console.error(`Error actualizando Item ${itemId}:`, error.message);
    throw error;
  }
}

async function createInvoice(invoicePayload) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.post(`${baseUrl}/invoice?minorversion=65`, invoicePayload);
    return response.data.Invoice;
  } catch (error) {
    console.error('Error creando Factura en QuickBooks:', error.message);
    throw error;
  }
}

async function getInvoice(invoiceId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/invoice/${invoiceId}?minorversion=65`);
    return response.data.Invoice;
  } catch (error) {
    console.error(`Error obteniendo la Factura ${invoiceId}:`, error.message);
    throw error;
  }
}

async function getCustomerById(customerId) {
  try {
    const baseUrl = await getBaseResourceUrl();
    const response = await qbClient.get(`${baseUrl}/customer/${customerId}?minorversion=65`);
    return response.data.Customer;
  } catch (error) {
    console.error(`Error obteniendo Customer ${customerId}:`, error.message);
    throw error;
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
    if (customerData.nit) payload.AlternatePhone = { FreeFormNumber: String(customerData.nit) };
    if (customerData.domain) {
      let uri = customerData.domain;
      if (uri && !uri.startsWith('http')) uri = `https://${uri}`;
      payload.WebAddr = { URI: uri };
    }

    const response = await qbClient.post(`${baseUrl}/customer?minorversion=65`, payload);
    return response.data.Customer;
  } catch (error) {
    console.error(`Error actualizando cliente ${qbCustomerId}:`, error.message);
    throw error;
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
    console.error(`Error actualizando factura ${qbInvoiceId}:`, error.message);
    throw error;
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
};
