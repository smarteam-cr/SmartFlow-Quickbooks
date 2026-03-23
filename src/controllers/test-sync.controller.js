const testSyncService = require('../services/test-sync.service');

const syncCustomers = async (request, reply) => {
  try {
    const resultado = await testSyncService.syncCustomersToHubSpot();

    return reply.code(200).send(resultado);
  } catch (error) {
    console.error('Error crítico en la sincronización de prueba:', error);
    return reply.code(500).send({
      error: 'Falló la sincronización de prueba',
      detalle: error.message,
    });
  }
};

module.exports = { syncCustomers };
