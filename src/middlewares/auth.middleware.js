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

  const signatureV3 = request.headers['x-hubspot-signature-v3'];
  const signatureV1 = request.headers['x-hubspot-signature'];
  const timestamp = request.headers['x-hubspot-request-timestamp'];

  if (!signatureV3 && !signatureV1) {
    logger.warn('[Security] Webhook HS rechazado: sin firma');
    return reply.status(401).send({ status: 'error', message: 'Firma requerida' });
  }

  // Anti-replay: rechazar si el webhook es de hace más de 5 minutos
  if (timestamp && Math.abs(Date.now() - parseInt(timestamp, 10)) > 300000) {
    logger.warn('[Security] Webhook HS rechazado: timestamp expirado');
    return reply.status(401).send({ status: 'error', message: 'Request expirado' });
  }

  const rawBody = request.rawBody || JSON.stringify(request.body);
  let isValid = false;

  if (signatureV3 && timestamp) {
    // v3: HMAC-SHA256(secret, METHOD + URI + body + timestamp) → base64
    const uri = `https://${request.headers.host}${request.url}`;
    const sourceString = `${request.method}${uri}${rawBody}${timestamp}`;
    const expectedHash = crypto
      .createHmac('sha256', config.hubspot.appSecret)
      .update(sourceString)
      .digest('base64');

    const expectedBuffer = Buffer.from(expectedHash);
    const signatureBuffer = Buffer.from(signatureV3);
    isValid = expectedBuffer.length === signatureBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } else if (signatureV1) {
    // v1 fallback: SHA256(secret + body) → hex
    const expectedHash = crypto
      .createHash('sha256')
      .update(config.hubspot.appSecret + rawBody)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedHash);
    const signatureBuffer = Buffer.from(signatureV1);
    isValid = expectedBuffer.length === signatureBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  if (!isValid) {
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