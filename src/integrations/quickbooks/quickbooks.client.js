const config = require("../../config");
const axios = require("axios");

const BASE_URL = config.quickbooks.baseUrl;

async function getPaymentDetails(realmId, paymentId, accessToken) {
  const url = `${BASE_URL}/${realmId}/payment/${paymentId}`;
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    return response.data;
  } catch (error) {
    throw new Error(
      `Error en API QuickBooks: ${error.response ? JSON.stringify(error.response.data) : error.message}`,
    );
  }
}

async function findCustomerByEmail(email) {
  try {
    const realmId = config.quickbooks.realmId;

    // Armamos la consulta tipo SQL que exige la API de QuickBooks
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;

    const url = `${config.quickbooks.baseUrl}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: "application/json",
      },
    });

    const customerInfo = response.data.QueryResponse.Customer;

    // QuickBooks devuelve un arreglo si lo encuentra, o nada si no existe
    if (customerInfo && customerInfo.length > 0) {
      return customerInfo[0]; // Retornamos el objeto del cliente encontrado
    } else {
      return null; // Retornamos null si el cliente no existe en QB
    }
  } catch (error) {
    console.error(
      "Error buscando cliente en QuickBooks:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

/**
 * Crea un Customer en QuickBooks con soporte para el modelo B2B:
 * - Empresa pura (Padre): pasa { companyName }
 * - Sub-customer (Hijo): pasa { firstName, lastName, email, parentRef, companyName }
 * - Contacto B2C estándar: pasa { firstName, lastName, email }
 *
 * @param {Object} customerData
 * @param {string} [customerData.companyName] - Nombre de empresa (crea empresa pura si no hay firstName/lastName)
 * @param {string} [customerData.firstName]
 * @param {string} [customerData.lastName]
 * @param {string} [customerData.email]
 * @param {string} [customerData.parentRef] - ID del Customer padre en QB (para sub-customers)
 * @param {string} [customerData.hsId] - ID de HubSpot para vínculo bidireccional (se guarda en Notes)
 */
async function createCustomer(customerData) {
  try {
    const realmId = config.quickbooks.realmId;
    const url = `${config.quickbooks.baseUrl}/${realmId}/customer?minorversion=65`;

    const isCompany =
      customerData.companyName &&
      !customerData.firstName &&
      !customerData.lastName;

    // Armamos el DisplayName según el tipo de registro
    let displayName;
    if (isCompany) {
      // Empresa pura: solo el nombre de la empresa
      displayName = customerData.companyName;
    } else if (customerData.parentRef && customerData.companyName) {
      // Sub-customer (Hijo): "Nombre (Empresa)"
      const fullName =
        `${customerData.firstName || ""} ${customerData.lastName || ""}`.trim();
      displayName = `${fullName} (${customerData.companyName})`;
    } else {
      // B2C estándar
      displayName =
        `${customerData.firstName || ""} ${customerData.lastName || ""}`.trim();
    }

    const payload = {
      DisplayName: displayName,
    };

    // Campos de persona (solo si no es empresa pura)
    if (!isCompany) {
      payload.GivenName = customerData.firstName || "";
      payload.FamilyName = customerData.lastName || "";
    }

    // CompanyName (para empresas y sub-customers)
    if (customerData.companyName) {
      payload.CompanyName = customerData.companyName;
    }

    // Email (si existe)
    if (customerData.email) {
      payload.PrimaryEmailAddr = { Address: customerData.email };
    }

    // ParentRef (para sub-customers hijos)
    if (customerData.parentRef) {
      payload.ParentRef = { value: customerData.parentRef };
      payload.Job = true;
    }

    // Vínculo bidireccional: guardamos el ID de HubSpot en el campo Notes
    if (customerData.hsId) {
      const prefix = isCompany ? "HS_COMPANY_ID" : "HS_CONTACT_ID";
      payload.Notes = `${prefix}:${customerData.hsId}`;
    }

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    return response.data.Customer;
  } catch (error) {
    const intuitError =
      error.response?.data?.Fault?.Error?.[0]?.Detail || error.message;
    console.error("Error creando cliente en QuickBooks:", intuitError);
    throw error;
  }
}

/**
 * Busca un Customer en QuickBooks por DisplayName exacto.
 * Útil para detectar duplicados antes de crear (DisplayName es único en QB).
 */
async function findCustomerByDisplayName(displayName) {
  try {
    const realmId = config.quickbooks.realmId;
    const query = `SELECT * FROM Customer WHERE DisplayName = '${displayName}'`;
    const url = `${config.quickbooks.baseUrl}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: "application/json",
      },
    });

    const customerInfo = response.data.QueryResponse.Customer;
    if (customerInfo && customerInfo.length > 0) {
      return customerInfo[0];
    }
    return null;
  } catch (error) {
    console.error(
      "Error buscando cliente por DisplayName en QuickBooks:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getAllCustomers() {
  try {
    const realmId = config.quickbooks.realmId;
    const query = "SELECT * FROM Customer maxResults 3 ";
    const url = `${config.quickbooks.baseUrl}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: "application/json",
      },
    });

    // Si no hay clientes, QueryResponse puede venir sin la propiedad Customer
    return response.data.QueryResponse.Customer || [];
  } catch (error) {
    console.error(
      "Error obteniendo clientes de QuickBooks:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function findItemByName(itemName) {
  try {
    const realmId = config.quickbooks.realmId;
    // Escapamos comillas simples en el nombre para evitar errores de sintaxis SQL en QBO
    const safeName = itemName.replace(/'/g, "\\'");
    const query = `SELECT * FROM Item WHERE Name = '${safeName}'`;
    const url = `${config.quickbooks.baseUrl}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: "application/json",
      },
    });

    const itemInfo = response.data.QueryResponse.Item;
    if (itemInfo && itemInfo.length > 0) {
      return itemInfo[0];
    }
    return null;
  } catch (error) {
    console.error(
      "Error buscando Item por nombre en QuickBooks:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function createItem(itemData) {
  try {
    const realmId = config.quickbooks.realmId;
    const url = `${config.quickbooks.baseUrl}/${realmId}/item?minorversion=65`;

    const response = await axios.post(url, itemData, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    return response.data.Item;
  } catch (error) {
    const intuitError =
      error.response?.data?.Fault?.Error?.[0]?.Detail || error.message;
    console.error("Error creando Item en QuickBooks:", intuitError);
    throw error;
  }
}

/**
 * Obtiene los detalles completos de un Item en QuickBooks usando su ID.
 * Requerido porque los webhooks de QB solo envían el ID de la entidad.
 * @param {string} itemId - El ID interno del Item en QuickBooks.
 */
async function getItemById(itemId) {
  try {
    const realmId = config.quickbooks.realmId;
    const url = `${config.quickbooks.baseUrl}/${realmId}/item/${itemId}?minorversion=65`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: 'application/json',
      },
    });

    return response.data.Item;
  } catch (error) {
    console.error(`Error obteniendo Item ${itemId} en QuickBooks:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Crea una Factura (Invoice) en QuickBooks.
 * @param {Object} invoicePayload - Objeto formateado según las reglas de Intuit.
 */
async function createInvoice(invoicePayload) {
  try {
    const realmId = config.quickbooks.realmId;
    const url = `${config.quickbooks.baseUrl}/${realmId}/invoice?minorversion=65`;

    const response = await axios.post(url, invoicePayload, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    return response.data.Invoice;
  } catch (error) {
    const intuitError = error.response?.data?.Fault?.Error?.[0]?.Detail || error.message;
    console.error('Error creando Factura en QuickBooks:', intuitError);
    if (error.response?.data?.Fault) {
      console.error('Detalles completos del error de QB:', JSON.stringify(error.response.data.Fault, null, 2));
    }
    throw error;
  }
}

module.exports = {
  getPaymentDetails,
  findCustomerByEmail,
  createCustomer,
  findCustomerByDisplayName,
  getAllCustomers,
  findItemByName,
  createItem,
  getItemById,
  createInvoice,
};
