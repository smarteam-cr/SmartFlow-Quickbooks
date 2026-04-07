const axios = require('axios');
const config = require('../config');
const Tenant = require('../db/models/tenant.model');

// Mutex para evitar renovaciones concurrentes de QuickBooks
let qbRefreshPromise = null;

/**
 * Obtiene el token de HubSpot directamente de la base de datos.
 * Cumple con el requerimiento V1.0 de leer siempre de DB para evitar desincronización.
 */
async function getHubSpotToken(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant || !tenant.hubspot?.accessToken) {
    throw new Error(`HubSpot credentials not found for tenant: ${tenantId}`);
  }
  return tenant.hubspot.accessToken;
}

/**
 * Obtiene el token de QuickBooks directamente de la base de datos.
 */
async function getQuickBooksToken(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant || !tenant.quickbooks?.accessToken) {
    throw new Error(`QuickBooks credentials not found for tenant: ${tenantId}`);
  }
  return tenant.quickbooks.accessToken;
}

/**
 * Obtiene la configuración completa de QuickBooks (token y realmId).
 */
async function getQuickBooksConfig(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant || !tenant.quickbooks) {
    throw new Error(`QuickBooks credentials not found for tenant: ${tenantId}`);
  }
  return {
    accessToken: tenant.quickbooks.accessToken,
    realmId: tenant.quickbooks.realmId
  };
}

/**
 * Renueva el token de QuickBooks. 
 * Implementa un bloqueo (Mutex) para asegurar que múltiples peticiones concurrentes
 * solo disparen un ciclo de renovación ante Intuit.
 */
async function refreshQuickBooksToken(tenantId) {
  // Si ya hay una renovación en curso para cualquier petición, esperamos a esa misma promesa
  if (qbRefreshPromise) {
    console.log(`[AuthService] Refresh already in progress for ${tenantId}. Waiting...`);
    return qbRefreshPromise;
  }

  qbRefreshPromise = (async () => {
    try {
      console.log(`[AuthService] Starting QuickBooks token refresh for tenant: ${tenantId}`);
      
      const tenant = await Tenant.findOne({ tenantId });
      if (!tenant || !tenant.quickbooks?.refreshToken) {
        throw new Error('No existe configuración de Tenant o Refresh Token válido.');
      }

      const authHeader = Buffer.from(
        `${config.quickbooks.clientId}:${config.quickbooks.clientSecret}`
      ).toString('base64');

      const response = await axios.post(
        'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tenant.quickbooks.refreshToken,
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

      // Actualización atómica en base de datos
      tenant.quickbooks.accessToken = access_token;
      tenant.quickbooks.refreshToken = refresh_token;
      tenant.quickbooks.tokenExpiresAt = new Date(Date.now() + expires_in * 1000);
      tenant.quickbooks.refreshTokenExpiresAt = new Date(Date.now() + x_refresh_token_expires_in * 1000);

      await tenant.save();
      console.log(`[AuthService] QuickBooks token refreshed successfully for ${tenantId}`);

      return access_token;
    } catch (error) {
      console.error(`[AuthService] Error refreshing QuickBooks token for ${tenantId}:`, error.response?.data || error.message);
      throw error;
    } finally {
      // Liberar el bloqueo al terminar (éxito o error)
      qbRefreshPromise = null;
    }
  })();

  return qbRefreshPromise;
}

module.exports = {
  getHubSpotToken,
  getQuickBooksToken,
  getQuickBooksConfig,
  refreshQuickBooksToken,
};
