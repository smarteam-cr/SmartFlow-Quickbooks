const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger.lib');

// Bypass de validación solo cuando el ambiente está EXPLÍCITAMENTE en dev/test.
// Si NODE_ENV está vacío, undefined o tiene un valor inesperado, no se aplica
// el bypass — evita que un deploy mal configurado en producción acepte webhooks
// sin firma por accidente.
const isDevOrTest = () => ['development', 'test'].includes(process.env.NODE_ENV);

const validateHubSpotSignature = (request, reply, done) => {
  if (isDevOrTest()) {
    logger.info('🚧 [Security] Validación de firma HS omitida (Modo Dev/Test).');
    return done();
  }

  if (!config.hubspot.appSecret) {
    logger.error('[Security] HUBSPOT_APP_SECRET no configurado en producción. Webhook rechazado.');
    return reply.status(503).send({ status: 'error', message: 'Servidor mal configurado' });
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
  if (isDevOrTest()) {
    logger.info('🚧 [Security] Validación de firma QB omitida (Modo Dev/Test).');
    return done();
  }

  if (!config.quickbooks.verifierToken) {
    logger.error('[Security] QB_WEBHOOK_VERIFIER_TOKEN no configurado en producción. Webhook rechazado.');
    return reply.status(503).send({ status: 'error', message: 'Servidor mal configurado' });
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