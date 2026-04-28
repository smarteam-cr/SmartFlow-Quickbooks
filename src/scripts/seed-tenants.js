require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Tenant = require('../db/models/tenant.model');
const { encrypt } = require('../lib/crypto.lib');

async function fetchHubSpotAccountInfo(accessToken) {
  const response = await axios.get('https://api.hubapi.com/account-info/v3/details', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data;
}

async function seedDatabase() {
  const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smartflow-quickbooks?replicaSet=rs0';

  try {
    console.log('Conectando a MongoDB...');
    await mongoose.connect(MONGO_URI);
    
    if (!process.env.HUBSPOT_ACCESS_TOKEN) {
      throw new Error("Falta HUBSPOT_ACCESS_TOKEN en el archivo .env");
    }

    const tenantId = process.env.DEFAULT_TENANT_ID || "cliente-oficial-1";

    // Consultar datos de la cuenta de HubSpot automáticamente
    console.log('Consultando datos de la cuenta de HubSpot...');
    const accountInfo = await fetchHubSpotAccountInfo(process.env.HUBSPOT_ACCESS_TOKEN);

    console.log(`- Portal ID: ${accountInfo.portalId}`);
    console.log(`- Zona horaria: ${accountInfo.timeZone} (${accountInfo.utcOffset})`);

    // Solo actualizamos datos básicos, HubSpot y preferencias.
    // Los campos de QuickBooks (tokens, realmId) NO se tocan aquí.
    // Esos los maneja exclusivamente el flujo OAuth (/auth/quickbooks/connect → callback).
    const result = await Tenant.findOneAndUpdate(
      { tenantId },
      {
        $set: {
          tenantId,
          name: accountInfo.portalId ? `Portal ${accountInfo.portalId}` : "Cliente",
          status: 'active',
          'hubspot.accessTokenEncrypted': encrypt(process.env.HUBSPOT_ACCESS_TOKEN),
          'hubspot.portalId': String(accountInfo.portalId),
          'hubspot.utcOffset': accountInfo.utcOffset,
          'hubspot.utcOffsetMilliseconds': accountInfo.utcOffsetMilliseconds,
        },
        $setOnInsert: {
          quickbooks: {},
          'preferences.taxMappings': {},
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    console.log(`\nTenant "${tenantId}" listo.`);
    console.log(`- HubSpot: token cifrado, portalId y zona horaria guardados`);
    console.log(`- QuickBooks: conectar vía GET /auth/quickbooks/connect`);

  } catch (error) {
    console.error('Error durante el seed:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

seedDatabase();