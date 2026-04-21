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

/**
 * Intercambia el authorization code de Intuit por tokens (access + refresh).
 * Se llama una sola vez después de que el usuario autoriza en la pantalla de Intuit.
 * 
 * @param {string} code - Código temporal que Intuit envía al callback
 * @param {string} realmId - ID de la empresa de QuickBooks que el usuario seleccionó
 * @param {string} tenantId - ID del tenant en nuestro sistema
 */
async function exchangeCodeForTokens(code, realmId, tenantId) {
  logger.info('[AuthService] Intercambiando code por tokens', { tenantId, realmId });

  // 1. Buscar el tenant en MongoDB (ya debe existir)
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) {
    throw new Error(`Tenant no encontrado: ${tenantId}`);
  }

  // 2. Construir el header de autenticación Basic (client_id:client_secret en base64)
  //    Es el mismo mecanismo que usa refreshQuickBooksToken
  const authHeader = Buffer.from(
    `${config.quickbooks.clientId}:${config.quickbooks.clientSecret}`
  ).toString('base64');

  // 3. POST a Intuit para intercambiar el code por tokens
  const response = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: config.quickbooks.redirectUri,
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
    x_refresh_token_expires_in,
  } = response.data;

  // 4. Cifrar tokens y guardar en el tenant
  tenant.quickbooks.realmId = realmId;
  tenant.quickbooks.accessTokenEncrypted = encrypt(access_token);
  tenant.quickbooks.refreshTokenEncrypted = encrypt(refresh_token);
  tenant.quickbooks.tokenExpiresAt = new Date(Date.now() + expires_in * 1000);
  tenant.quickbooks.refreshTokenExpiresAt = new Date(Date.now() + x_refresh_token_expires_in * 1000);

  await tenant.save();

  logger.info('[AuthService] Tokens de QB guardados exitosamente', { tenantId, realmId });

  // 5. Auto-descubrir preferencias del QB del cliente (tax codes, income account)
  try {
    await discoverQbPreferences(tenantId);
  } catch (err) {
    // No fallar el OAuth si el descubrimiento falla — se puede hacer manualmente después
    logger.warn('[AuthService] No se pudieron descubrir preferencias de QB automáticamente', { error: err.message });
  }

  return {
    tenantId,
    realmId,
    tokenExpiresAt: tenant.quickbooks.tokenExpiresAt,
    refreshTokenExpiresAt: tenant.quickbooks.refreshTokenExpiresAt,
  };
}

/**
 * Consulta la API de QB para descubrir automáticamente:
 * - La cuenta de ingresos (Income Account) → incomeAccountId
 * - El código de impuesto y su tasa → defaultTaxCodeId, defaultTaxRateId, defaultTaxRatePercent
 * 
 * Se ejecuta una vez después del OAuth. Los valores se guardan en tenant.preferences.
 */
async function discoverQbPreferences(tenantId) {
  const qbClient = require('../integrations/quickbooks/quickbooks.client');
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) throw new Error(`Tenant no encontrado: ${tenantId}`);

  logger.info('[AuthService] Descubriendo preferencias de QB...', { tenantId });

  // Descubrir TaxRates y TaxCodes
  const taxRates = await qbClient.getTaxRates();
  const taxCodes = await qbClient.getTaxCodes();

  // Buscar una tasa que sea del 13% (IVA Costa Rica) o la tasa más alta disponible
  // Esto cubre el caso del cliente actual y es razonable como default
  let targetRate = taxRates.find(r => Number(r.RateValue) === 13);
  
  if (!targetRate && taxRates.length > 0) {
    // Si no hay 13%, tomar la tasa activa más alta como default
    targetRate = taxRates
      .filter(r => r.Active !== false)
      .sort((a, b) => Number(b.RateValue) - Number(a.RateValue))[0];
  }

  if (targetRate) {
    tenant.preferences.defaultTaxRateId = targetRate.Id;
    tenant.preferences.defaultTaxRatePercent = Number(targetRate.RateValue);
    logger.info(`[AuthService] TaxRate descubierto: "${targetRate.Name}" (ID: ${targetRate.Id}, ${targetRate.RateValue}%)`);

    // Buscar el TaxCode que usa este TaxRate
    const matchingCode = taxCodes.find(tc => {
      if (!tc.SalesTaxRateList?.TaxRateDetail) return false;
      return tc.SalesTaxRateList.TaxRateDetail.some(
        detail => String(detail.TaxRateRef?.value) === String(targetRate.Id)
      );
    });

    if (matchingCode) {
      tenant.preferences.defaultTaxCodeId = matchingCode.Id;
      logger.info(`[AuthService] TaxCode descubierto: "${matchingCode.Name}" (ID: ${matchingCode.Id})`);
    }
  }

  await tenant.save();
  logger.info('[AuthService] Preferencias de QB guardadas', { tenantId });
}

/**
 * Consulta el estado de la conexión OAuth de QuickBooks para un tenant.
 * No descifra tokens — solo verifica si existen y cuándo expiran.
 */
async function getConnectionStatus(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });

  if (!tenant) {
    return { connected: false, reason: 'Tenant no encontrado' };
  }

  const hasTokens = !!tenant.quickbooks?.accessTokenEncrypted && !!tenant.quickbooks?.refreshTokenEncrypted;

  if (!hasTokens) {
    return { connected: false, reason: 'Sin tokens de QuickBooks' };
  }

  const now = new Date();
  const tokenExpired = tenant.quickbooks.tokenExpiresAt && tenant.quickbooks.tokenExpiresAt < now;
  const refreshExpired = tenant.quickbooks.refreshTokenExpiresAt && tenant.quickbooks.refreshTokenExpiresAt < now;

  return {
    connected: !refreshExpired,
    realmId: tenant.quickbooks.realmId,
    environment: tenant.quickbooks.environment,
    accessTokenExpired: !!tokenExpired,
    accessTokenExpiresAt: tenant.quickbooks.tokenExpiresAt,
    refreshTokenExpired: !!refreshExpired,
    refreshTokenExpiresAt: tenant.quickbooks.refreshTokenExpiresAt,
  };
}

/**
 * Desconecta QuickBooks de un tenant.
 * Borra tokens cifrados, realmId y fechas de expiración.
 * El tenant sigue existiendo — solo pierde la conexión con QB.
 */
async function disconnectQuickBooks(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });

  if (!tenant) {
    throw new Error(`Tenant no encontrado: ${tenantId}`);
  }

  tenant.quickbooks.accessTokenEncrypted = undefined;
  tenant.quickbooks.refreshTokenEncrypted = undefined;
  tenant.quickbooks.realmId = undefined;
  tenant.quickbooks.tokenExpiresAt = undefined;
  tenant.quickbooks.refreshTokenExpiresAt = undefined;

  await tenant.save();

  logger.info('[AuthService] QuickBooks desconectado', { tenantId });
}

module.exports = {
  getHubSpotToken,
  getQuickBooksToken,
  getQuickBooksConfig,
  refreshQuickBooksToken,
  exchangeCodeForTokens,
  getConnectionStatus,
  disconnectQuickBooks,
};