const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger.lib');

const validateApiKey = (request, reply, done) => {
  const apiKey = request.headers['x-api-key'];
  const expected = config.security.internalApiKey;

  // timingSafeEqual exige buffers de igual longitud; un mismatch de longitud
  // se rechaza primero para evitar el throw y para no filtrar la longitud
  // esperada vía error de tipo.
  const reject = () => {
    logger.warn(`[Security] Acceso interno rechazado: API Key inválida. IP: ${request.ip}`);
    return reply.status(403).send({ status: 'error', message: 'Acceso denegado' });
  };

  if (!apiKey || typeof apiKey !== 'string' || apiKey.length !== expected.length) {
    return reject();
  }

  const apiKeyBuf = Buffer.from(apiKey);
  const expectedBuf = Buffer.from(expected);

  if (!crypto.timingSafeEqual(apiKeyBuf, expectedBuf)) {
    return reject();
  }

  done();
};

module.exports = { validateApiKey };
