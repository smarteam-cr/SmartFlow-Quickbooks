const config = require("../../config");
const axios = require("axios");

async function getContactDetails(contactId) {
  try {
    // Le decimos a HubSpot qué propiedades específicas queremos que nos devuelva.
    // Como mínimo necesitamos el email para buscar en QuickBooks.
    const properties = "email,firstname,lastname,company,phone,address,city,state,zip,country,id_usuario_quickbooks";

    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data;
  } catch (error) {
    // Si es un 404 (No encontrado), retornamos null en lugar de lanzar un error
    if (error.response && error.response.status === 404) {
      console.warn(
        `El contacto ${contactId} devolvió 404 en HubSpot (Posiblemente fue borrado).`,
      );
      return null;
    }

    // Si es otro tipo de error (ej. token inválido o caída de servidor), sí lanzamos el error
    console.error(
      `Error crítico obteniendo el contacto ${contactId} de HubSpot:`,
      error.response?.data || error.message,
    );
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

    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data;
  } catch (error) {
    console.error(
      `Error actualizando el ID en HubSpot para el contacto ${contactId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function updateCompanyProperty(companyId, qbId) {
  try {
    const payload = {
      properties: { id_usuario_quickbooks: qbId.toString() },
    };
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data;
  } catch (error) {
    console.error(
      `Error actualizando el ID en HubSpot para la empresa ${companyId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getAllContacts() {
  try {
    let allContacts = [];
    let after = undefined;

    console.log("Descargando contactos históricos de HubSpot...");

    // Usamos un bucle do-while para la "paginación"
    do {
      let url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=35&properties=email,firstname,lastname,id_usuario_quickbooks`;
      if (after) {
        url += `&after=${after}`; // Agregamos el cursor para la siguiente página
      }

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      // Sumamos los contactos de esta página a nuestra lista total
      allContacts = allContacts.concat(response.data.results);

      // Verificamos si hay más páginas
      after = response.data.paging?.next?.after;
    } while (after);

    console.log(`Se descargaron ${allContacts.length} contactos de HubSpot.`);
    return allContacts;
  } catch (error) {
    console.error(
      "Error obteniendo todos los contactos de HubSpot:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function batchCreateContacts(contacts) {
  try {
    const payload = { inputs: contacts };

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/create",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data;
  } catch (error) {
    // El batch puede devolver 207 (multi-status) o 400 con errores parciales
    // Si hay respuesta con data, la retornamos para que el servicio la analice
    if (error.response?.data) {
      return error.response.data;
    }
    console.error("Error en batch create de HubSpot:", error.message);
    throw error;
  }
}

async function createCompany(properties) {
  try {
    const payload = { properties };
    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/companies",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data; // Retorna el objeto que incluye el ID generado
  } catch (error) {
    console.error(
      `Error creando la empresa en HubSpot:`,
      error.response?.data || error.message,
    );
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
        id_usuario_quickbooks: qbId ? qbId.toString() : "", // Guardamos el ID del Hijo
      },
    };
    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data;
  } catch (error) {
    if (error.response?.status === 409) {
      console.warn(
        `Aviso: El contacto ${contactData.email} ya existe en HubSpot.`,
      );
      const existingId = error.response.data.message.match(/\d+/)[0];
      return { id: existingId };
    }
    console.error(
      "Error creando contacto en HubSpot:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function associateContactToCompany(contactId, companyId) {
  try {
    // Tipo de asociación 279 o 1 es el identificador por defecto para Company -> Contact en HubSpot (Depende de la versión de portal, usaremos la sintaxis estándar de v3)
    const response = await axios.put(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/contacts/${contactId}/company_to_contact`,
      {},
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data;
  } catch (error) {
    console.error(
      `Error asociando Contacto ${contactId} a Empresa ${companyId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function searchCompanyByQbId(qbId) {
  try {
    const payload = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "id_usuario_quickbooks",
              operator: "EQ",
              value: qbId.toString(),
            },
          ],
        },
      ],
    };

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/companies/search",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    // Si encuentra la empresa, devuelve su ID de HubSpot. Si no, devuelve null.
    if (response.data.total > 0) {
      return response.data.results[0].id;
    }
    return null;
  } catch (error) {
    console.error(
      `Error buscando empresa con QB ID ${qbId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getAllCompanies() {
  try {
    let allCompanies = [];
    let after = undefined;

    console.log("Descargando empresas de HubSpot...");

    do {
      let url = `https://api.hubapi.com/crm/v3/objects/companies?limit=100&properties=name,domain,id_usuario_quickbooks`;
      if (after) {
        url += `&after=${after}`;
      }

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      allCompanies = allCompanies.concat(response.data.results);
      after = response.data.paging?.next?.after;
    } while (after);

    console.log(`Se descargaron ${allCompanies.length} empresas de HubSpot.`);
    return allCompanies;
  } catch (error) {
    console.error(
      "Error obteniendo empresas de HubSpot:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getAssociatedContactIds(companyId) {
  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/contacts`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    // La API retorna { results: [{ id: "contactId", type: "..." }, ...] }
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    // Si no tiene asociaciones, la API puede devolver un 404 o un array vacío
    if (error.response?.status === 404) {
      return [];
    }
    console.error(
      `Error obteniendo asociaciones de la empresa ${companyId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getAllContactsWithCompanyAssociations() {
  try {
    let allContacts = [];
    let after = undefined;

    console.log(
      "Descargando contactos de HubSpot con sus asociaciones (Padres)...",
    );

    do {
      // El secreto está en el parámetro &associations=company
      let url = `https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=email,firstname,lastname,company&associations=company`;
      if (after) {
        url += `&after=${after}`;
      }

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      allContacts = allContacts.concat(response.data.results);
      after = response.data.paging?.next?.after;
    } while (after);

    console.log(
      `Se descargaron ${allContacts.length} contactos con asociaciones.`,
    );
    return allContacts;
  } catch (error) {
    console.error(
      "Error obteniendo contactos con asociaciones:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getCompanyDetails(companyId) {
  try {
    const properties = [
      "name",
      "nit",
      "phone",
      "domain",
      "address",
      "city",
      "country",
      "id_usuario_quickbooks"
    ].join(",");
    
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) return null;
    console.error(
      `Error obteniendo detalles de empresa ${companyId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getDealDetails(dealId) {
  try {
    // Pedimos propiedades clave: nombre del negocio, monto total y etapa
    const properties = "dealname,amount,dealstage";
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    return response.data;
  } catch (error) {
    console.error(
      `Error obteniendo el negocio ${dealId} de HubSpot:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getLineItemsByDealId(dealId) {
  try {
    // 1. Obtener los IDs de los "Line Items" asociados a este Negocio
    const assocResponse = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/line_items`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    // Mapeamos para el formato que pide el batch read de HubSpot
    const lineItemIds = assocResponse.data.results.map((assoc) => ({
      id: assoc.id,
    }));

    if (lineItemIds.length === 0) {
      return []; // El negocio no tiene productos asociados
    }

    // 2. Obtener los detalles reales de esos productos (nombre, precio, cantidad)
    const batchPayload = {
      inputs: lineItemIds,
      properties: ["name", "price", "quantity", "hs_sku", "description","es_gravable"],
    };

    const detailsResponse = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/line_items/batch/read",
      batchPayload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return detailsResponse.data.results;
  } catch (error) {
    if (error.response?.status === 404) {
      console.warn(
        `El negocio ${dealId} no tiene line items asociados o no existen.`,
      );
      return [];
    }
    console.error(
      `Error obteniendo line items para el negocio ${dealId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function getProductDetails(productId) {
  try {
    // Definimos las propiedades del producto necesarias para crear el Item en QuickBooks
    const properties = "name,price,description,hs_sku,id_producto_quickbooks,es_gravable,hs_price_usd";

    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/products/${productId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.warn(
        `El producto ${productId} devolvió 404 en HubSpot.`,
      );
      return null;
    }

    console.error(
      `Error obteniendo el producto ${productId} de HubSpot:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

async function updateProductProperty(productId, qbId) {
  try {
    const payload = {
      properties: {
        id_producto_quickbooks: qbId.toString(),
      },
    };

    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/products/${productId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data;
  } catch (error) {
    console.error(
      `Error actualizando el ID en HubSpot para el producto ${productId}:`,
      error.response?.data || error.message,
    );
    throw error;
  }
}

// Crea un nuevo producto en HubSpot.
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

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/products",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("Error creando producto en HubSpot:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Busca un producto en HubSpot utilizando el ID de QuickBooks.
 * Vital para evitar bucles infinitos en la sincronización bidireccional.
 */
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

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/products/search",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.total > 0) {
      return response.data.results[0]; // Retorna el producto encontrado
    }
    return null;
  } catch (error) {
    console.error(`Error buscando producto en HubSpot con QB ID ${qbId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Obtiene los detalles de una Factura (Invoice) en HubSpot.
 */
async function getInvoiceDetails(invoiceId) {
  try {
    // Propiedades: monto total, estado, y nuestra propiedad personalizada
    const properties = "hs_invoice_total,hs_status,hs_title,id_factura_quickbooks,hs_invoice_date,hs_due_date";
    
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/invoices/${invoiceId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    if (error.response?.status === 404) {
      console.warn(`La factura ${invoiceId} devolvió 404 en HubSpot.`);
      return null;
    }
    console.error(`Error obteniendo la factura ${invoiceId} de HubSpot:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Obtiene las asociaciones de una Factura (Invoice).
 * Puede buscar contactos, empresas o line_items asociados.
 * @param {string} invoiceId - ID de la factura.
 * @param {string} toObjectType - 'contacts', 'companies', o 'line_items'.
 */
async function getInvoiceAssociations(invoiceId, toObjectType) {
  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/invoices/${invoiceId}/associations/${toObjectType}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    
    // Retornamos un arreglo plano con los IDs encontrados
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) {
      return []; // No tiene asociaciones de este tipo
    }
    console.error(`Error obteniendo asociaciones de ${toObjectType} para la factura ${invoiceId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Actualiza la factura en HubSpot para guardar el ID generado por QuickBooks.
 */
async function updateInvoiceProperty(invoiceId, qbInvoiceId) {
  try {
    const payload = {
      properties: {
        id_factura_quickbooks: qbInvoiceId.toString(),
      },
    };

    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/invoices/${invoiceId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(`Error actualizando el ID en HubSpot para la factura ${invoiceId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Obtiene los detalles completos de múltiples Line Items por sus IDs.
 * @param {Array<string>} lineItemIds - Arreglo de IDs de Line Items.
 */
async function getLineItemsDetails(lineItemIds) {
  if (!lineItemIds || lineItemIds.length === 0) return [];

  try {
    const batchPayload = {
      inputs: lineItemIds.map(id => ({ id })),
      // Pedimos las propiedades vitales, incluyendo nuestra ancla de QuickBooks
      properties: ["name", "price", "quantity", "hs_sku", "description", "id_producto_quickbooks", "es_gravable"]
    };

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/line_items/batch/read",
      batchPayload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.results;
  } catch (error) {
    console.error("Error obteniendo detalles de los Line Items:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Busca una factura en HubSpot utilizando una propiedad personalizada (ej. id_factura_quickbooks).
 * Vital para encontrar a qué factura pertenece un pago entrante.
 * @param {string} propertyName - Nombre interno de la propiedad en HubSpot.
 * @param {string} value - Valor a buscar (El ID de la factura en QuickBooks).
 */
async function searchInvoiceByCustomProperty(propertyName, value) {
  try {
    const payload = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: propertyName,
              operator: "EQ",
              value: value.toString(),
            },
          ],
        },
      ],
    };

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/invoices/search",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.total > 0) {
      return response.data.results[0]; // Retorna la factura encontrada
    }
    return null;
  } catch (error) {
    console.error(
      `Error buscando factura en HubSpot con ${propertyName} = ${value}:`,
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Actualiza múltiples propiedades de una factura en HubSpot.
 * Se usará para inyectar el hs_amount_paid y cambiar el estado de la factura a Pagado.
 * @param {string} invoiceId - ID de la factura en HubSpot.
 * @param {object} propertiesToUpdate - Objeto llave:valor con las propiedades a actualizar.
 */
async function updateInvoice(invoiceId, propertiesToUpdate) {
  try {
    const payload = {
      properties: propertiesToUpdate,
    };

    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/invoices/${invoiceId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error(
      `Error actualizando propiedades (pagos) en la factura ${invoiceId}:`,
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Obtiene los IDs de las empresas asociadas a un contacto.
 * @param {string} contactId - ID del contacto en HubSpot.
 */
async function getContactAssociatedCompanyIds(contactId) {
  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/companies`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    
    // Retornamos un arreglo plano con los IDs de las empresas
    return response.data.results.map((assoc) => assoc.id);
  } catch (error) {
    if (error.response?.status === 404) {
      return [];
    }
    console.error(`Error obteniendo asociaciones de empresas para el contacto ${contactId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Actualiza múltiples propiedades de un contacto en HubSpot.
 */
async function updateContact(contactId, properties) {
  try {
    const payload = { properties };
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(`Error actualizando contacto ${contactId} en HubSpot:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Actualiza múltiples propiedades de una empresa en HubSpot.
 */
async function updateCompany(companyId, properties) {
  try {
    const payload = { properties };
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(`Error actualizando empresa ${companyId} en HubSpot:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Busca un contacto en HubSpot utilizando el ID de QuickBooks.
 */
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

    const response = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.total > 0) {
      return response.data.results[0]; 
    }
    return null;
  } catch (error) {
    console.error(`Error buscando contacto en HubSpot con QB ID ${qbId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Elimina la asociación entre un contacto y una empresa.
 */
async function disassociateContactFromCompany(contactId, companyId) {
  try {
    // Usamos el endpoint de eliminación de asociaciones
    await axios.delete(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}/associations/contacts/${contactId}/company_to_contact`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return true;
  } catch (error) {
    console.error(`Error desasociando Contacto ${contactId} de Empresa ${companyId}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Actualiza propiedades de un producto en HubSpot.
 */
async function updateProduct(productId, properties) {
  try {
    const payload = { properties };
    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/products/${productId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(`Error actualizando producto ${productId} en HubSpot:`, error.response?.data || error.message);
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
  updateContact,
  updateCompany,
  searchContactByQbId,
  disassociateContactFromCompany,
};
