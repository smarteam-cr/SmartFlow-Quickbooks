const axios = require('axios');

const getContactDetails = async (contactId) => {
  try {
    // Le decimos a HubSpot qué propiedades específicas queremos que nos devuelva.
    // Como mínimo necesitamos el email para buscar en QuickBooks.
    const properties = 'email,firstname,lastname,company'; 
    
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${properties}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error(`Error obteniendo el contacto ${contactId} de HubSpot:`, error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  getContactDetails
};