const migrationController = require('../controllers/migration.controller.js');
const testSyncController = require('../controllers/test-sync.controller.js');

module.exports = async function (fastify, opts) {
  // Endpoint para migrar contactos históricos
  fastify.post('/api/migration/contacts', migrationController.syncHistoricalContacts);

  // Endpoint PoC: sincronización de prueba QB → HubSpot
  fastify.post('/api/migration/sync-customers', testSyncController.syncCustomers);
};