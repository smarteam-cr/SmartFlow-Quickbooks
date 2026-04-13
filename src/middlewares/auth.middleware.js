const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger.lib');

/**
 * Valida la firma de HubSpot para asegurar que la petición es legítima.
 */
const validateHubSpotSignature = (request, reply, done) => {
  const appSecret = config.hubspot.appSecret;
  
  if (!appSecret) {
    logger.warn('[Auth] HUBSPOT_APP_SECRET no configurado en config. Saltando validación (Inseguro).');
    return done();
  }

  const signature = request.headers['x-hubspot-signature'];
  if (!signature) {
    logger.error('[Auth] Petición rechazada: Falta X-HubSpot-Signature');
    return reply.status(401).send({ status: 'error', message: 'Firma de HubSpot faltante' });
  }

  const payload = JSON.stringify(request.body);
  const sourceString = appSecret + payload;
  const hash = crypto.createHash('sha256').update(sourceString).digest('hex');
  console.log(hash)
  console.log(signature)

  if (hash !== signature) {
    logger.error('[Auth] Petición rechazada: Firma de HubSpot inválida');
    return reply.status(401).send({ status: 'error', message: 'Firma inválida' });
  }

  done();
};

/**
 * Valida la firma de QuickBooks.
 */
const validateIntuitSignature = (request, reply, done) => {
  const verifierToken = config.quickbooks.verifierToken;
  
  if (!verifierToken) {
    logger.warn('[Auth] QB_WEBHOOK_VERIFIER_TOKEN no configurado. Saltando validación.');
    return done();
  }

  const signature = request.headers['intuit-signature'];
  if (!signature) {
    logger.error('[Auth] Petición rechazada: Falta intuit-signature');
    return reply.status(401).send({ status: 'error', message: 'Firma de QuickBooks faltante' });
  }

  const payload = JSON.stringify(request.body);
  const hash = crypto
    .createHmac('sha256', verifierToken)
    .update(payload)
    .digest('base64');

  if (hash !== signature) {
    logger.error('[Auth] Petición rechazada: Firma de QuickBooks inválida');
    return reply.status(401).send({ status: 'error', message: 'Firma de QuickBooks inválida' });
  }

  done();
};

module.exports = {
  validateHubSpotSignature,
  validateIntuitSignature
};
