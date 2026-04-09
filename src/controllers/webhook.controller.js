const jobService = require('../services/job.service');
const logger = require('../lib/logger.lib');
const { AppError } = require('../utils/errors.util');

async function handleQuickBooksWebhook(request, reply) {
  const payload = request.body;
  logger.info('--- Webhook de QB recibido ---');

  if (payload.eventNotifications) {
    for (const notification of payload.eventNotifications) {
      for (const entity of notification.dataChangeEvent.entities) {
        
        // Mapeo de entidades de QB a nuestro estándar interno
        const entityMapping = {
          'Payment': 'payment',
          'Item': 'product',
          'Invoice': 'invoice',
          'Customer': 'contact'
        };

        const internalEntity = entityMapping[entity.name];
        
        // Filtro de operaciones (Reglas de negocio)
        const validOps = ['Create', 'Update', 'Emailed'];
        
        if (internalEntity && validOps.includes(entity.operation)) {
          const job = await jobService.createJob({
            source: 'QUICKBOOKS',
            entity: internalEntity,
            entityId: entity.id,
            eventType: `qb.${entity.name.toLowerCase()}.${entity.operation.toLowerCase()}`,
            payload: entity
          });
          logger.info(`✅ Job creado en BD [${job._id}] para QB ${internalEntity} ID: ${entity.id}`);
        }
      }
    }
  }

  return reply.status(200).send('OK');
}

async function handleHubSpotWebhook(request, reply) {
  const events = request.body;
  logger.info(`Webhook de HubSpot recibido con ${events.length} eventos.`);

  for (const event of events) {
    const targetId = event.fromObjectId || event.objectId;
    
    if (!targetId) {
      logger.warn(`⚠️ Evento ${event.subscriptionType} ignorado por falta de ID.`, { event });
      continue;
    }

    const entityMap = {
      'contact.creation': 'contact',
      'contact.propertyChange': 'contact',
      'contact.associationChange': 'contact',
      'company.creation': 'company',
      'company.propertyChange': 'company',
      'product.creation': 'product',
      'product.propertyChange': 'product',
    };

    let internalEntity = entityMap[event.subscriptionType];

    // Casos Especiales por ObjectTypeId (Facturas y Line Items Beta)
    if (event.objectTypeId === '0-53') {
      internalEntity = 'invoice';
    } else if (event.objectTypeId === '0-27' || event.subscriptionType.startsWith('line_item')) {
      internalEntity = 'line_item';
    }

    if (internalEntity && targetId) {
      const job = await jobService.createJob({
        source: 'HUBSPOT',
        entity: internalEntity,
        entityId: targetId.toString(),
        eventType: event.subscriptionType,
        payload: event
      });

      logger.info(`✅ Job creado en BD [${job._id}] para HubSpot ${internalEntity} ID: ${targetId}`);
    }
  }

  return reply.code(200).send({ status: 'success' });
}
module.exports = { 
  handleQuickBooksWebhook, 
  handleHubSpotWebhook 
};