const migrationService = require('../services/migration.service');
const logger = require('../lib/logger.lib');

const syncHistoricalContacts = async (request, reply) => {
  try {
    logger.info('Iniciando migración histórica de contactos (QB -> HS)');
    const stats = await migrationService.syncHistoricalContacts();

    return reply.code(200).send({
      message: 'Migración histórica completada',
      resultados: stats
    });

  } catch (error) {
    logger.error('Error crítico en la migración:', error);
    return reply.code(500).send({ error: 'Fallo la migración masiva' });
  }
};

module.exports = { syncHistoricalContacts };