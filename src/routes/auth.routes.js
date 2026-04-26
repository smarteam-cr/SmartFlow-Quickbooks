const authController = require('../controllers/auth.controller');
const { validateApiKey } = require('../middlewares/api-key.middleware');

module.exports = async (fastify) => {
  // Endpoints administrativos: requieren API key.
  // El callback NO se protege con API key porque Intuit lo invoca redirigiendo
  // al navegador del usuario y no puede enviar headers — su autenticación es
  // el state aleatorio validado contra OAuthState.
  fastify.get('/quickbooks/connect', { preHandler: validateApiKey }, authController.connect);
  fastify.get('/quickbooks/callback', authController.callback);
  fastify.get('/quickbooks/status', { preHandler: validateApiKey }, authController.status);
  fastify.post('/quickbooks/disconnect', { preHandler: validateApiKey }, authController.disconnect);
};