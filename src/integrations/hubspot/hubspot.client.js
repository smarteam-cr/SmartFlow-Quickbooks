const axios = require("axios");
const authService = require("../../services/auth.service");
const logger = require("../../lib/logger.lib");
const { DEFAULT_TENANT_ID } = require("../../config/constants");

// Instancia centralizada de Axios para HubSpot
const hsClient = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    "Content-Type": "application/json",
  },
});

// Interceptor de Petición: Inyecta el token dinámicamente desde la base de datos
hsClient.interceptors.request.use(async (reqConfig) => {
  try {
    const token = await authService.getHubSpotToken(DEFAULT_TENANT_ID);
    reqConfig.headers.Authorization = `Bearer ${token}`;
    return reqConfig;
  } catch (error) {
    return Promise.reject(error);
  }
});

async function getContactDetails(contactId) {
  try {
    const properties = "email,firstname,lastname,company,phone,address,city,state,zip,country,id_usuario_quickbooks";
    const response = await hsClient.get(`/crm/v3/objects/contacts/${contactId}?properties=${properties}`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      logger.warn(`El contacto ${contactId} devolvió 404 en HubSpot (Posiblemente fue borrado).`);
      return null;
    }
    logger.error(`Error crítico obteniendo el contacto ${contactId} de HubSpot:`, error);
    throw error;
  }
}

async function updateContactProperty(contactId, qbId) {
  try {
    const payload = {
      properties: {
        id_usuario_quickbooks: qbId.toString(),
      },
    };
    const response = await hsClient.patch(`/crm/v3/objects/contacts/${contactId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando el ID en HubSpot para el contacto ${contactId}:`, error);
    throw error;
  }
}

async function updateCompanyProperty(companyId, qbId) {
  try {
    const payload = {
      properties: { id_usuario_quickbooks: qbId.toString() },
    };
    const response = await hsClient.patch(`/crm/v3/objects/companies/${companyId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando el ID en HubSpot para la empresa ${companyId}:`, error);
    throw error;
  }
}

async function getAllContacts() {
  try {
    let allContacts = [];
    let after = undefined;
    logger.info("Descargando contactos históricos de HubSpot...");
    do {
      let url = `/crm/v3/objects/contacts?limit=35&properties=email,firstname,lastname,id_usuario_quickbooks`;
      if (after) {
        url += `&after=${after}`;
      }
      const response = await hsClient.get(url);
      allContacts = allContacts.concat(response.data.results);
      after = response.data.paging?.next?.after;
    } while (after);
    logger.info(`Se descargaron ${allContacts.length} contactos de HubSpot.`);
    return allContacts;
  } catch (error) {
    logger.error("Error obteniendo todos los contactos de HubSpot:", error);
    throw error;
  }
}

async function batchCreateContacts(contacts) {
  try {
    const payload = { inputs: contacts };
    const response = await hsClient.post("/crm/v3/objects/contacts/batch/create", payload);
    return response.data;
  } catch (error) {
    if (error.response?.data) {
      return error.response.data;
    }
    logger.error("Error en batch create de HubSpot:", error);
    throw error;
  }
}

async function createCompany(properties) {
  try {
    const payload = { properties };
    const response = await hsClient.post("/crm/v3/objects/companies", payload);
    return response.data;
  } catch (error) {
    logger.error(`Error creando la empresa en HubSpot:`, error);
    throw error;
  }
}

async function createSingleContact(contactData, qbId) {
  try {
    const payload = {
      properties: {
        firstname: contactData.firstname || "",
        lastname: contactData.lastname || "",
        email: contactData.email || "",
        id_usuario_quickbooks: qbId ? qbId.toString() : "",
      },
    };
    const response = await hsClient.post("/crm/v3/objects/contacts", payload);
    return response.data;
  } catch (error) {
    if (error.response?.status === 409) {
      logger.warn(`Aviso: El contacto ${contactData.email} ya existe en HubSpot.`);
      const existingId = error.response.data.message.match(/\d+/)[0];
      return { id: existingId };
    }
    logger.error("Error creando contacto en HubSpot:", error);
    throw error;
  }
}

async function associateContactToCompany(contactId, companyId) {
  try {
    const response = await hsClient.put(`/crm/v3/objects/companies/${companyId}/associations/contacts/${contactId}/company_to_contact`, {});
    return response.data;
  } catch (error) {
    logger.error(`Error asociando Contacto ${contactId} a Empresa ${companyId}:`, error);
    throw error;
  }
}

async function searchCompanyByQbId(qbId) {
  try {
    const payload = {
      filterGroups: [{
        filters: [{
          propertyName: "id_usuario_quickbooks",
          operator: "EQ",
          value: qbId.toString(),
        }],
      }],
    };
    const response = await hsClient.post("/crm/v3/objects/companies/search", payload);
    if (response.data.total > 0) {
      return response.data.results[0].id;
    }
    return null;
  } catch (error) {
    logger.error(`Error buscando empresa con QB ID ${qbId}:`, error);
    throw error;
  }
}

async function getAllCompanies() {
  try {
    let allCompanies = [];
    let after = undefined;
    logger.info("Descargando empresas de HubSpot...");
    do {
      let url = `/crm/v3/objects/companies?limit=100&properties=name,domain,id_usuario_quickbooks`;
      if (after) {
        url += `&after=${after}`;
      }
      const response = await hsClient.get(url);
      allCompanies = allCompanies.concat(response.data.results);
      after = response.data.paging?.next?.after;
    } while (after);
    logger.info(`Se descargaron ${allCompanies.length} empresas de HubSpot.`);
    return allCompanies;
  } catch (error) {
    logger.error("Error obteniendo empresas de HubSpot:", error);
    throw error;
  }
}

async function getAssociatedContactIds(companyId) {
  try {
    const response = await hsClient.get(`/crm/v3/objects/companies/${companyId}/associations/contacts`);
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) {
      return [];
    }
    logger.error(`Error obteniendo asociaciones de la empresa ${companyId}:`, error);
    throw error;
  }
}

async function getAllContactsWithCompanyAssociations() {
  try {
    let allContacts = [];
    let after = undefined;
    logger.info("Descargando contactos de HubSpot con sus asociaciones (Padres)...");
    do {
      let url = `/crm/v3/objects/contacts?limit=100&properties=email,firstname,lastname,company&associations=company`;
      if (after) {
        url += `&after=${after}`;
      }
      const response = await hsClient.get(url);
      allContacts = allContacts.concat(response.data.results);
      after = response.data.paging?.next?.after;
    } while (after);
    logger.info(`Se descargaron ${allContacts.length} contactos con asociaciones.`);
    return allContacts;
  } catch (error) {
    logger.error("Error obteniendo contactos con asociaciones:", error);
    throw error;
  }
}

async function getCompanyDetails(companyId) {
  try {
    const properties = ["name","nit","phone","domain","address","city","country","id_usuario_quickbooks"].join(",");
    const response = await hsClient.get(`/crm/v3/objects/companies/${companyId}?properties=${properties}`);
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    logger.error(`Error obteniendo detalles de empresa ${companyId}:`, error);
    throw error;
  }
}

async function getDealDetails(dealId) {
  try {
    const properties = "dealname,amount,dealstage";
    const response = await hsClient.get(`/crm/v3/objects/deals/${dealId}?properties=${properties}`);
    return response.data;
  } catch (error) {
    logger.error(`Error obteniendo el negocio ${dealId} de HubSpot:`, error);
    throw error;
  }
}

async function getLineItemsByDealId(dealId) {
  try {
    const assocResponse = await hsClient.get(`/crm/v3/objects/deals/${dealId}/associations/line_items`);
    const lineItemIds = assocResponse.data.results.map((assoc) => ({ id: assoc.id }));
    if (lineItemIds.length === 0) return [];

    const batchPayload = {
      inputs: lineItemIds,
      properties: ["name", "price", "quantity", "hs_sku", "description", "es_gravable"],
    };
    const detailsResponse = await hsClient.post("/crm/v3/objects/line_items/batch/read", batchPayload);
    return detailsResponse.data.results;
  } catch (error) {
    if (error.response?.status === 404) {
      logger.warn(`El negocio ${dealId} no tiene line items asociados o no existen.`);
      return [];
    }
    logger.error(`Error obteniendo line items para el negocio ${dealId}:`, error);
    throw error;
  }
}

async function getProductDetails(productId) {
  try {
    const properties = "name,price,description,hs_sku,id_producto_quickbooks,es_gravable,hs_price_usd";
    const response = await hsClient.get(`/crm/v3/objects/products/${productId}?properties=${properties}`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      logger.warn(`El producto ${productId} devolvió 404 en HubSpot.`);
      return null;
    }
    logger.error(`Error obteniendo el producto ${productId} de HubSpot:`, error);
    throw error;
  }
}

async function updateProductProperty(productId, qbId) {
  try {
    const payload = { properties: { id_producto_quickbooks: qbId.toString() } };
    const response = await hsClient.patch(`/crm/v3/objects/products/${productId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando el ID en HubSpot para el producto ${productId}:`, error);
    throw error;
  }
}

async function createProduct(productData) {
  try {
    const payload = {
      properties: {
        name: productData.name,
        price: productData.price ? productData.price.toString() : "0",
        description: productData.description || "",
        hs_sku: productData.hs_sku || "",
        es_gravable: productData.isTaxable ? "true" : "false",
        id_producto_quickbooks: productData.qbId.toString()
      }
    };
    const response = await hsClient.post("/crm/v3/objects/products", payload);
    return response.data;
  } catch (error) {
    logger.error("Error creando producto en HubSpot:", error);
    throw error;
  }
}

async function searchProductByQbId(qbId) {
  try {
    const payload = {
      filterGroups: [{
        filters: [{
          propertyName: "id_producto_quickbooks",
          operator: "EQ",
          value: qbId.toString()
        }]
      }]
    };
    const response = await hsClient.post("/crm/v3/objects/products/search", payload);
    if (response.data.total > 0) {
      return response.data.results[0];
    }
    return null;
  } catch (error) {
    logger.error(`Error buscando producto en HubSpot con QB ID ${qbId}:`, error);
    throw error;
  }
}

async function getInvoiceDetails(invoiceId) {
  try {
    const properties = "hs_invoice_total,hs_status,hs_title,id_factura_quickbooks,hs_invoice_date,hs_due_date";
    const response = await hsClient.get(`/crm/v3/objects/invoices/${invoiceId}?properties=${properties}`);
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      logger.warn(`La factura ${invoiceId} devolvió 404 en HubSpot.`);
      return null;
    }
    logger.error(`Error obteniendo la factura ${invoiceId} de HubSpot:`, error);
    throw error;
  }
}

async function getInvoiceAssociations(invoiceId, toObjectType) {
  try {
    const response = await hsClient.get(`/crm/v3/objects/invoices/${invoiceId}/associations/${toObjectType}`);
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) return [];
    logger.error(`Error obteniendo asociaciones de ${toObjectType} para la factura ${invoiceId}:`, error);
    throw error;
  }
}

async function updateInvoiceProperty(invoiceId, qbInvoiceId) {
  try {
    const payload = { properties: { id_factura_quickbooks: qbInvoiceId.toString() } };
    const response = await hsClient.patch(`/crm/v3/objects/invoices/${invoiceId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando el ID en HubSpot para la factura ${invoiceId}:`, error);
    throw error;
  }
}

async function getLineItemsDetails(lineItemIds) {
  if (!lineItemIds || lineItemIds.length === 0) return [];
  try {
    const batchPayload = {
      inputs: lineItemIds.map(id => ({ id })),
      properties: ["name", "price", "quantity", "hs_sku", "description", "id_producto_quickbooks", "es_gravable"]
    };
    const response = await hsClient.post("/crm/v3/objects/line_items/batch/read", batchPayload);
    return response.data.results;
  } catch (error) {
    logger.error("Error obteniendo detalles de los Line Items:", error);
    throw error;
  }
}

async function searchInvoiceByCustomProperty(propertyName, value) {
  try {
    const payload = {
      filterGroups: [{
        filters: [{
          propertyName: propertyName,
          operator: "EQ",
          value: value.toString(),
        }],
      }],
    };
    const response = await hsClient.post("/crm/v3/objects/invoices/search", payload);
    if (response.data.total > 0) {
      return response.data.results[0];
    }
    return null;
  } catch (error) {
    logger.error(`Error buscando factura en HubSpot con ${propertyName} = ${value}:`, error);
    throw error;
  }
}

async function updateInvoice(invoiceId, propertiesToUpdate) {
  try {
    const payload = { properties: propertiesToUpdate };
    const response = await hsClient.patch(`/crm/v3/objects/invoices/${invoiceId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando propiedades en la factura ${invoiceId}:`, error);
    throw error;
  }
}

async function getContactAssociatedCompanyIds(contactId) {
  try {
    const response = await hsClient.get(`/crm/v3/objects/contacts/${contactId}/associations/companies`);
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) return [];
    logger.error(`Error obteniendo asociaciones de empresas para el contacto ${contactId}:`, error);
    throw error;
  }
}

async function updateContact(contactId, properties) {
  try {
    const payload = { properties };
    const response = await hsClient.patch(`/crm/v3/objects/contacts/${contactId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando contacto ${contactId} en HubSpot:`, error);
    throw error;
  }
}

async function updateCompany(companyId, properties) {
  try {
    const payload = { properties };
    const response = await hsClient.patch(`/crm/v3/objects/companies/${companyId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando empresa ${companyId} en HubSpot:`, error);
    throw error;
  }
}

async function searchContactByQbId(qbId) {
  try {
    const payload = {
      filterGroups: [{
        filters: [{
          propertyName: "id_usuario_quickbooks",
          operator: "EQ",
          value: qbId.toString()
        }]
      }]
    };
    const response = await hsClient.post("/crm/v3/objects/contacts/search", payload);
    if (response.data.total > 0) {
      return response.data.results[0];
    }
    return null;
  } catch (error) {
    logger.error(`Error buscando contacto en HubSpot con QB ID ${qbId}:`, error);
    throw error;
  }
}

async function getDealAssociatedContacts(dealId) {
  try {
    const response = await hsClient.get(`/crm/v3/objects/deals/${dealId}/associations/contacts`);
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) return [];
    logger.error(`Error obteniendo asociaciones de contactos para el negocio ${dealId}:`, error);
    throw error;
  }
}

async function associateInvoiceToContact(invoiceId, contactId) {
  try {
    await hsClient.put(`/crm/v3/objects/invoices/${invoiceId}/associations/contacts/${contactId}/invoice_to_contact`, {});
    return true;
  } catch (error) {
    logger.error(`Error asociando Factura ${invoiceId} a Contacto ${contactId}:`, error);
    throw error;
  }
}

async function associateInvoiceToDeal(invoiceId, dealId) {
  try {
    await hsClient.put(`/crm/v3/objects/invoices/${invoiceId}/associations/deals/${dealId}/invoice_to_deal`, {});
    return true;
  } catch (error) {
    logger.error(`Error asociando Factura ${invoiceId} a Negocio ${dealId}:`, error);
    throw error;
  }
}

async function getLineItemAssociations(lineItemId, toObjectType) {
  try {
    const response = await hsClient.get(`/crm/v3/objects/line_items/${lineItemId}/associations/${toObjectType}`);
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) return [];
    logger.error(`Error obteniendo asociaciones para el Line Item ${lineItemId} hacia ${toObjectType}:`, error);
    throw error;
  }
}

async function disassociateContactFromCompany(contactId, companyId) {
  try {
    await hsClient.delete(`/crm/v3/objects/companies/${companyId}/associations/contacts/${contactId}/company_to_contact`);
    return true;
  } catch (error) {
    logger.error(`Error desasociando Contacto ${contactId} de Empresa ${companyId}:`, error);
    throw error;
  }
}

async function updateProduct(productId, properties) {
  try {
    const payload = { properties };
    const response = await hsClient.patch(`/crm/v3/objects/products/${productId}`, payload);
    return response.data;
  } catch (error) {
    logger.error(`Error actualizando producto ${productId} en HubSpot:`, error);
    throw error;
  }
}

module.exports = {
  getContactDetails,
  updateContactProperty,
  getAllContacts,
  batchCreateContacts,
  createCompany,
  createSingleContact,
  associateContactToCompany,
  searchCompanyByQbId,
  getAllCompanies,
  getAssociatedContactIds,
  getAllContactsWithCompanyAssociations,
  updateCompanyProperty,
  getCompanyDetails,
  getDealDetails,
  getLineItemsByDealId,
  getProductDetails,
  updateProductProperty,
  createProduct,
  searchProductByQbId,
  updateProduct,
  getInvoiceDetails,
  getInvoiceAssociations,
  updateInvoiceProperty,
  getLineItemsDetails,
  searchInvoiceByCustomProperty,
  updateInvoice,
  getContactAssociatedCompanyIds,
  getDealAssociatedContacts,
  associateInvoiceToContact,
  associateInvoiceToDeal,
  updateContact,
  updateCompany,
  searchContactByQbId,
  disassociateContactFromCompany,
  getLineItemAssociations,
};
