const config = require('../../config');
const axios = require('axios');

async function getContactDetails(contactId) {
  try {
    // Le decimos a HubSpot qué propiedades específicas queremos que nos devuelva.
    // Como mínimo necesitamos el email para buscar en QuickBooks.
    const properties = 'email,firstname,lastname,company';

    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    return response.data;
  } catch (error) {
    // Si es un 404 (No encontrado), retornamos null en lugar de lanzar un error
    if (error.response && error.response.status === 404) {
      console.warn(`El contacto ${contactId} devolvió 404 en HubSpot (Posiblemente fue borrado).`);
      return null;
    }

    // Si es otro tipo de error (ej. token inválido o caída de servidor), sí lanzamos el error
    console.error(
      `Error crítico obteniendo el contacto ${contactId} de HubSpot:`,
      error.response?.data || error.message,
    );
    throw error;
  }
};

async function updateContactProperty(contactId, qbId) {
  try {
    const payload = {
      properties: {
        "id_usuario_quickbooks": qbId.toString()
      }
    };

    const response = await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.hubspot.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error(`Error actualizando el ID en HubSpot para el contacto ${contactId}:`, error.response?.data || error.message);
    throw error;
  }
};

async function getAllContacts () {
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
          'Content-Type': 'application/json'
        }
      });

      // Sumamos los contactos de esta página a nuestra lista total
      allContacts = allContacts.concat(response.data.results);
      
      // Verificamos si hay más páginas
      after = response.data.paging?.next?.after;
      
    } while (after);

    console.log(`Se descargaron ${allContacts.length} contactos de HubSpot.`);
    return allContacts;

  } catch (error) {
    console.error("Error obteniendo todos los contactos de HubSpot:", error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  getContactDetails,
  updateContactProperty,
  getAllContacts,
};
