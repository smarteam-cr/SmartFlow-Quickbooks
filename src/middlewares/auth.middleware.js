const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger.lib');

const validateHubSpotSignature = (request, reply, done) => {
  // 🚧 [Security] Validación de firma HS omitida temporalmente (Modo Dev).
  if (process.env.NODE_ENV !== 'production') {
    logger.info('🚧 [Security] Validación de firma HS omitida temporalmente (Modo Dev).');
    return done();
  }

  if (!config.hubspot.appSecret) {
    logger.warn('[Security] HUBSPOT_APP_SECRET no configurado. Saltando validación (Inseguro).');
    return done();
  }

  const signature = request.headers['x-hubspot-signature-v3'] || request.headers['x-hubspot-signature'];
  const timestamp = request.headers['x-hubspot-request-timestamp'];

  if (!signature) {
    logger.warn('[Security] Webhook HS rechazado: sin firma');
    return reply.status(401).send({ status: 'error', message: 'Firma requerida' });
  }

  // Anti-replay: rechazar si el webhook es de hace más de 5 minutos
  if (timestamp && Math.abs(Date.now() - parseInt(timestamp, 10)) > 300000) {
    logger.warn('[Security] Webhook HS rechazado: timestamp expirado');
    return reply.status(401).send({ status: 'error', message: 'Request expirado' });
  }

  const rawBody = request.rawBody || JSON.stringify(request.body);
  const sourceString = config.hubspot.appSecret + rawBody;
  const expectedHash = crypto.createHash('sha256').update(sourceString).digest('hex');

  const expectedBuffer = Buffer.from(expectedHash);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    logger.warn('[Security] Webhook HS rechazado: firma inválida');
    return reply.status(401).send({ status: 'error', message: 'Firma inválida' });
  }

  done();
};

const validateIntuitSignature = (request, reply, done) => {
  // 🚧 |[Security] Validación de firma QB omitida temporalmente (Modo Dev).

  if (process.env.NODE_ENV !== 'production') {
    logger.info('🚧 [Security] Validación de firma QB omitida temporalmente (Modo Dev).');
    return done();
  }

  if (!config.quickbooks.verifierToken) {
    logger.warn('[Security] QB_WEBHOOK_VERIFIER_TOKEN no configurado. Saltando validación.');
    return done();
  }

  const signature = request.headers['intuit-signature'];
  if (!signature) {
    logger.warn('[Security] Webhook QB rechazado: sin firma');
    return reply.status(401).send({ status: 'error', message: 'Firma requerida' });
  }

  const rawBody = request.rawBody || JSON.stringify(request.body);
  const expectedHash = crypto
    .createHmac('sha256', config.quickbooks.verifierToken)
    .update(rawBody)
    .digest('base64');

  const expectedBuffer = Buffer.from(expectedHash);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    logger.warn('[Security] Webhook QB rechazado: firma inválida');
    return reply.status(401).send({ status: 'error', message: 'Firma de QuickBooks inválida' });
  }

  done();
};

module.exports = { validateHubSpotSignature, validateIntuitSignature };