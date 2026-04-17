const authController = require('../controllers/auth.controller');

module.exports = async (fastify) => {
  fastify.get('/quickbooks/connect', authController.connect);
  fastify.get('/quickbooks/callback', authController.callback);
  fastify.get('/quickbooks/status', authController.status);
  fastify.post('/quickbooks/disconnect', authController.disconnect);
};