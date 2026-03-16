// src/integrations/quickbooks/quickbooks.client.js
require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.QB_SANDBOX_BASE_URL;

async function getPaymentDetails(realmId, paymentId, accessToken) {
  const url = `${BASE_URL}/${realmId}/payment/${paymentId}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    throw new Error(`Error en API QuickBooks: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
  }
}

const findCustomerByEmail = async (email) => {
  try {
    const realmId = process.env.QB_REALM_ID;

    // Armamos la consulta tipo SQL que exige la API de QuickBooks
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;

    const url = `${process.env.QB_SANDBOX_BASE_URL}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.QB_TEST_ACCESS_TOKEN}`,
        Accept: 'application/json'
      }
    });

    const customerInfo = response.data.QueryResponse.Customer;

    // QuickBooks devuelve un arreglo si lo encuentra, o nada si no existe
    if (customerInfo && customerInfo.length > 0) {
      return customerInfo[0]; // Retornamos el objeto del cliente encontrado
    } else {
      return null; // Retornamos null si el cliente no existe en QB
    }

  } catch (error) {
    console.error("Error buscando cliente en QuickBooks:", error.response?.data || error.message);
    throw error;
  }
};

module.exports = { getPaymentDetails, findCustomerByEmail };