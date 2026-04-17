// src/controllers/auth.controller.js
// Controlador OAuth 2.0 para QuickBooks Online.
// Responsabilidad: recibir HTTP, validar params, construir URLs, delegar lógica de tokens.
// Preparado para multitenant: usa tenantId del query param o DEFAULT_TENANT_ID como fallback.

const config = require('../config');
const { DEFAULT_TENANT_ID } = require('../config/constants');
const authService = require('../services/auth.service');
const { responseHelper } = require('../lib/response.lib');
const logger = require('../lib/logger.lib');

// URL oficial de Intuit para iniciar el flujo OAuth 2.0
const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

/**
 * GET /auth/quickbooks/connect
 * 
 * Genera la URL de autorización de Intuit y la devuelve como JSON.
 * El usuario (o cliente) debe abrir esta URL en su navegador para autorizar.
 * 
 * Query params opcionales:
 *   - tenantId: identifica al cliente. Si no viene, usa DEFAULT_TENANT_ID.
 * 
 * Responde con:
 *   { status: 'success', data: { authUrl: 'https://appcenter.intuit.com/connect/oauth2?...' } }
 */
async function connect(request, reply) {
  const tenantId = request.query.tenantId || DEFAULT_TENANT_ID;

  // Validar que las credenciales OAuth están configuradas
  if (!config.quickbooks.clientId || !config.quickbooks.redirectUri) {
    logger.error('[Auth/Connect] Faltan QB_CLIENT_ID o QB_REDIRECT_URI en la configuración');
    return reply.status(500).send(
      responseHelper.error('Configuración OAuth de QuickBooks incompleta en el servidor')
    );
  }

  // Construir la URL de autorización con los parámetros que Intuit exige
  const params = new URLSearchParams({
    client_id: config.quickbooks.clientId,
    redirect_uri: config.quickbooks.redirectUri,
    response_type: 'code',                          // Siempre 'code' en OAuth 2.0 Authorization Code Flow
    scope: 'com.intuit.quickbooks.accounting',       // Permiso para acceder a datos contables
    state: tenantId,                                 // Intuit lo devuelve tal cual en el callback
  });

  const authUrl = `${INTUIT_AUTH_URL}?${params.toString()}`;

  logger.info('[Auth/Connect] URL de autorización generada', { tenantId, correlationId: request.correlationId });

  return reply.send(responseHelper.success({ authUrl, tenantId }));
}

/**
 * GET /auth/quickbooks/callback
 * 
 * Intuit redirige aquí después de que el usuario autoriza.
 * Recibe el code temporal, lo intercambia por tokens y los guarda cifrados.
 * 
 * Query params (enviados por Intuit automáticamente):
 *   - code: código temporal de autorización (un solo uso)
 *   - state: el tenantId que enviamos en connect
 *   - realmId: ID de la empresa de QuickBooks que el usuario seleccionó
 *   - error: presente solo si el usuario rechazó la autorización
 */
async function callback(request, reply) {
  const { code, state, realmId, error: authError } = request.query;

  // Si el usuario rechazó la autorización, Intuit envía ?error=access_denied
  if (authError) {
    logger.warn('[Auth/Callback] Usuario rechazó la autorización', { error: authError });
    return reply.status(400).send(
      responseHelper.error('El usuario rechazó la autorización de QuickBooks')
    );
  }

  // Validar que llegaron los 3 parámetros obligatorios
  if (!code || !realmId || !state) {
    logger.warn('[Auth/Callback] Parámetros incompletos', { code: !!code, realmId: !!realmId, state: !!state });
    return reply.status(400).send(
      responseHelper.error('Parámetros incompletos en el callback de QuickBooks')
    );
  }

  const tenantId = state; // state contiene el tenantId que enviamos en connect

  try {
    const result = await authService.exchangeCodeForTokens(code, realmId, tenantId);

    logger.info('[Auth/Callback] Conexión OAuth completada', { tenantId, realmId, correlationId: request.correlationId });

    return reply.send(responseHelper.success({
      message: 'Conexión con QuickBooks exitosa. Los tokens fueron guardados de forma segura.',
      tenantId: result.tenantId,
      realmId: result.realmId,
      tokenExpiresAt: result.tokenExpiresAt,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
    }));

  } catch (err) {
    logger.error('[Auth/Callback] Error intercambiando code por tokens', {
      tenantId,
      realmId,
      error: err.message,
      correlationId: request.correlationId,
    });

    return reply.status(500).send(
      responseHelper.error('Error al conectar con QuickBooks. Intenta de nuevo.')
    );
  }
}

/**
 * GET /auth/quickbooks/status
 * 
 * Consulta el estado de la conexión OAuth del tenant.
 * No expone tokens — solo dice si está conectado y cuándo expiran.
 */
async function status(request, reply) {
  const tenantId = request.query.tenantId || DEFAULT_TENANT_ID;

  try {
    const connectionStatus = await authService.getConnectionStatus(tenantId);

    logger.info('[Auth/Status] Estado consultado', { tenantId, connected: connectionStatus.connected });

    return reply.send(responseHelper.success(connectionStatus));

  } catch (err) {
    logger.error('[Auth/Status] Error consultando estado', { tenantId, error: err.message });
    return reply.status(500).send(
      responseHelper.error('Error al consultar el estado de conexión')
    );
  }
}

/**
 * POST /auth/quickbooks/disconnect
 * 
 * Desconecta QuickBooks del tenant. Borra los tokens pero no el tenant.
 * Después de esto, el cliente debe reconectarse vía /auth/quickbooks/connect.
 */
async function disconnect(request, reply) {
  const tenantId = request.body?.tenantId || DEFAULT_TENANT_ID;

  try {
    await authService.disconnectQuickBooks(tenantId);

    logger.info('[Auth/Disconnect] QuickBooks desconectado', { tenantId, correlationId: request.correlationId });

    return reply.send(responseHelper.success({
      message: 'QuickBooks desconectado exitosamente',
      tenantId,
    }));

  } catch (err) {
    logger.error('[Auth/Disconnect] Error desconectando', { tenantId, error: err.message });
    return reply.status(500).send(
      responseHelper.error('Error al desconectar QuickBooks')
    );
  }
}

module.exports = { connect, callback, status, disconnect };