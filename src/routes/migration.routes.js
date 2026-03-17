const migrationController = require('../controllers/migration.controller.js');

module.exports = async function (fastify, opts) {
  // Endpoint para migrar contactos históricos
  fastify.post('/api/migration/contacts', migrationController.syncHistoricalContacts);
};