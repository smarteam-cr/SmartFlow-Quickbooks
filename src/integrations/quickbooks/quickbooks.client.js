const config = require('../../config');
const axios = require('axios');

const BASE_URL = config.quickbooks.baseUrl;

async function getPaymentDetails(realmId, paymentId, accessToken) {
  const url = `${BASE_URL}/${realmId}/payment/${paymentId}`;
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
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
        Accept: 'application/json',
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
    console.error('Error buscando cliente en QuickBooks:', error.response?.data || error.message);
    throw error;
  }
}

async function createCustomer(customerData) {
  try {
    const realmId = config.quickbooks.realmId;
    const url = `${config.quickbooks.baseUrl}/${realmId}/customer?minorversion=65`;

    // Armamos el "Payload" (el cuerpo del mensaje) tal como lo exige QuickBooks
    const payload = {
      GivenName: customerData.firstName || '',
      FamilyName: customerData.lastName || '',
      // DisplayName es obligatorio en QB y debe ser ÚNICO en toda la cuenta.
      DisplayName: `${customerData.firstName || ''} ${customerData.lastName || ''}`.trim(),
      PrimaryEmailAddr: {
        Address: customerData.email,
      },
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });

    // Retornamos el objeto del cliente recién creado (que incluye su nuevo ID generado por QB)
    return response.data.Customer;
  } catch (error) {
    // Extraemos el detalle del error de Intuit si existe, para que sea fácil depurar
    const intuitError = error.response?.data?.Fault?.Error?.[0]?.Detail || error.message;
    console.error('Error creando cliente en QuickBooks:', intuitError);
    throw error;
  }
}

async function getAllCustomers() {
  try {
    const realmId = config.quickbooks.realmId;
    const query = 'SELECT * FROM Customer MAXRESULTS 4';
    const url = `${config.quickbooks.baseUrl}/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${config.quickbooks.accessToken}`,
        Accept: 'application/json',
      },
    });

    // Si no hay clientes, QueryResponse puede venir sin la propiedad Customer
    return response.data.QueryResponse.Customer || [];
  } catch (error) {
    console.error('Error obteniendo clientes de QuickBooks:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { getPaymentDetails, findCustomerByEmail, createCustomer, getAllCustomers };
