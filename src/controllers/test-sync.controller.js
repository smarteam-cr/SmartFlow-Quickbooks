const testSyncService = require('../services/test-sync.service');

async function syncCustomers(request, reply) {
  try {
    console.log('[Controller] Petición de sincronización (QB -> HS) recibida');
    
    // Delegamos la lógica pesada al servicio
    const resultados = await testSyncService.executeSync();

    if (!resultados) {
      return reply.status(200).send({ message: 'No se encontraron clientes en QuickBooks para procesar.' });
    }

    return reply.status(200).send({ 
      message: 'Sincronización finalizada con éxito', 
      resultados 
    });

  } catch (error) {
    console.error('[Controller] Error crítico en la petición:', error);
    return reply.status(500).send({ error: 'Fallo interno durante la sincronización.' });
  }
}

module.exports = { syncCustomers };