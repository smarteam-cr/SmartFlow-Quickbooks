const config = require("../../config");
const axios = require("axios");

async function getContactDetails(contactId) {
  try {
    // Le decimos a HubSpot qué propiedades específicas queremos que nos devuelva.
    // Como mínimo necesitamos el email para buscar en QuickBooks.
    const properties = "email,firstname,lastname,company";

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

async function createCompany(companyName, qbId) {
  try {
    const payload = {
      properties: {
        name: companyName,
        id_usuario_quickbooks: qbId.toString(), // Guardamos el ID del Padre
      },
    };
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
      `Error creando la empresa ${companyName} en HubSpot:`,
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
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain,id_usuario_quickbooks`,
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
      properties: ["name", "price", "quantity", "hs_sku"],
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
    const properties = "name,price,description,hs_sku,id_producto_quickbooks";

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
        id_producto_quickbooks: productData.qbId.toString() // Guardamos el ancla inmediatamente
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
};
