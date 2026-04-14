// src/services/auth.service.js
const axios = require('axios');
const config = require('../config');
const Tenant = require('../db/models/tenant.model');
const logger = require('../lib/logger.lib');
const { encrypt, decrypt } = require('../lib/crypto.lib');

// Map Multitenant para evitar renovaciones concurrentes del mismo cliente
// Key: tenantId, Value: Promise de renovación
const qbRefreshPromises = new Map();

async function getHubSpotToken(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant || !tenant.hubspot?.accessTokenEncrypted) {
    throw new Error(`Credenciales de HubSpot no encontradas para el tenant: ${tenantId}`);
  }
  return decrypt(tenant.hubspot.accessTokenEncrypted);
}

async function getQuickBooksToken(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant || !tenant.quickbooks?.accessTokenEncrypted) {
    throw new Error(`Credenciales de QuickBooks no encontradas para el tenant: ${tenantId}`);
  }
  return decrypt(tenant.quickbooks.accessTokenEncrypted);
}

async function getQuickBooksConfig(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant || !tenant.quickbooks) {
    throw new Error(`Configuración de QuickBooks no encontrada para el tenant: ${tenantId}`);
  }
  return {
    accessToken: decrypt(tenant.quickbooks.accessTokenEncrypted),
    realmId: tenant.quickbooks.realmId
  };
}

async function refreshQuickBooksToken(tenantId) {
  // Si ya hay una renovación en curso PARA ESTE TENANT, devolvemos la misma promesa
  if (qbRefreshPromises.has(tenantId)) {
    logger.info(`[AuthService] Refresh en progreso para ${tenantId}. Esperando...`);
    return qbRefreshPromises.get(tenantId);
  }

  const promise = (async () => {
    try {
      logger.info(`[AuthService] Iniciando refresh de token QB para tenant: ${tenantId}`);

      const tenant = await Tenant.findOne({ tenantId });
      const currentRefreshToken = decrypt(tenant?.quickbooks?.refreshTokenEncrypted);
      
      if (!tenant || !currentRefreshToken) {
        throw new Error('No existe configuración de Tenant o Refresh Token válido.');
      }

      const authHeader = Buffer.from(
        `${config.quickbooks.clientId}:${config.quickbooks.clientSecret}`
      ).toString('base64');

      const response = await axios.post(
        'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentRefreshToken,
        }).toString(),
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${authHeader}`,
          },
        }
      );

      const {
        access_token,
        refresh_token,
        expires_in,
        x_refresh_token_expires_in
      } = response.data;

      // Ciframos los nuevos tokens antes de guardar
      tenant.quickbooks.accessTokenEncrypted = encrypt(access_token);
      tenant.quickbooks.refreshTokenEncrypted = encrypt(refresh_token);
      tenant.quickbooks.tokenExpiresAt = new Date(Date.now() + expires_in * 1000);
      tenant.quickbooks.refreshTokenExpiresAt = new Date(Date.now() + x_refresh_token_expires_in * 1000);

      await tenant.save();
      logger.info(`[AuthService] Token de QB refrescado exitosamente para ${tenantId}`);

      return access_token;
    } catch (error) {
      logger.error(`[AuthService] Error refrescando token de QB para ${tenantId}:`, error);
      throw error;
    } finally {
      // Liberar el bloqueo al terminar (éxito o error)
      qbRefreshPromises.delete(tenantId);
    }
  })();

  // Guardamos la promesa en el Map
  qbRefreshPromises.set(tenantId, promise);
  
  return promise;
}

module.exports = {
  getHubSpotToken,
  getQuickBooksToken,
  getQuickBooksConfig,
  refreshQuickBooksToken,
};