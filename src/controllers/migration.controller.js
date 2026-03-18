const migrationService = require('../services/migration.service');

const syncHistoricalContacts = async (request, reply) => {
  try {
    const stats = await migrationService.syncHistoricalContacts();

    return reply.code(200).send({
      message: 'Migración histórica completada',
      resultados: stats
    });

  } catch (error) {
    console.error('Error crítico en la migración:', error);
    return reply.code(500).send({ error: 'Fallo la migración masiva' });
  }
};

module.exports = { syncHistoricalContacts };