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

    // Casos Especiales por ObjectTypeId (Facturas, Line Items y Pagos HS)
    // Casos Especiales por ObjectTypeId (Facturas, Line Items y Pagos HS)
    if (event.objectTypeId === '0-53') {
      internalEntity = 'invoice';

      // --- ESCUDO PARA FACTURAS (hs_balance_due) ---
      if (event.subscriptionType === 'object.propertyChange' && event.propertyName === 'hs_balance_due') {
        const balance = Number(event.propertyValue);

        if (isNaN(balance) || balance > 0) {
          logger.info(`[Webhook/HS] Factura ${targetId} con saldo parcial (${event.propertyValue}). Ignorando, no se crea en QB.`);
          continue; // 🛑 Se rechaza, no toca la BD, pasa al siguiente evento
        }

        logger.info(`[Webhook/HS] ¡Factura ${targetId} pagada! Saldo es 0. Transformando evento para creación en QB.`);

        // Transformamos el evento internamente para que tu Worker.js re-use la lógica actual de creación
        event.subscriptionType = 'object.creation';
      }
      else if (event.subscriptionType === 'object.creation') {
        // Bloqueo de seguridad: como ya apagaste esto en HS, si llega alguno colgado, lo ignoramos
        continue;
      }
      // Si es object.propertyChange de OTRAS propiedades, seguirá su curso normal...

    } else if (event.objectTypeId === '0-27' || event.subscriptionType.startsWith('line_item')) {
      internalEntity = 'line_item';
    } else if (event.objectTypeId === '0-101') {
      internalEntity = 'hs_payment';
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