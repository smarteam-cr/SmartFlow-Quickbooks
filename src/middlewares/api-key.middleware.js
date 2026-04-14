const config = require('../config');
const logger = require('../lib/logger.lib');

const validateApiKey = (request, reply, done) => {
  const apiKey = request.headers['x-api-key'];

  if (!apiKey || apiKey !== config.security.internalApiKey) {
    logger.warn(`[Security] Acceso interno rechazado: API Key inválida. IP: ${request.ip}`);
    return reply.status(403).send({ status: 'error', message: 'Acceso denegado' });
  }

  done();
};

module.exports = { validateApiKey };