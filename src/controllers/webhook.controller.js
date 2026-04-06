const jobService = require('../services/job.service');

async function handleQuickBooksWebhook(request, reply) {
  console.log('--- Webhook de QB recibido ---'); // Agrega esto para depurar
  const payload = request.body;
  try {

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
          
          // Filtro de operaciones (Tus reglas de negocio)
          const validOps = ['Create', 'Update', 'Emailed'];
          
          if (internalEntity && validOps.includes(entity.operation)) {
            await jobService.createJob({
              source: 'QUICKBOOKS',
              entity: internalEntity,
              entityId: entity.id,
              eventType: `qb.${entity.name.toLowerCase()}.${entity.operation.toLowerCase()}`,
              payload: entity
            });
          }
        }
      }
    }

    return reply.status(200).send('OK');
  } catch (error) {
    // Aquí implementaremos Winston más adelante
    console.error('Error en controlador QB:', error);
    return reply.status(500).send('Error');
  }
}

async function handleHubSpotWebhook(request, reply) {
  try {
    const events = request.body;

    for (const event of events) {
      const targetId = event.fromObjectId || event.objectId;
      
      if (!targetId) {
        console.warn(`⚠️ Evento ${event.subscriptionType} ignorado por falta de ID.`);
        continue;
      }

      const entityMap = {
        'contact.creation': 'contact',
        'contact.propertyChange': 'contact',
        'contact.associationChange': 'contact', // Agregado para integridad
        'company.creation': 'company',
        'company.propertyChange': 'company',
        'product.creation': 'product',
        'product.propertyChange': 'product',
        'deal.creation': 'invoice',
        'deal.propertyChange': 'invoice',
      };

      let internalEntity = entityMap[event.subscriptionType];

      // Casos Especiales por ObjectTypeId (Facturas y Line Items Beta)
      if (event.objectTypeId === '0-53') {
        internalEntity = 'invoice';
      } else if (event.objectTypeId === '0-27' || event.subscriptionType.startsWith('line_item')) {
        internalEntity = 'line_item';
      }

      // Usamos tu validación exacta:
      if (internalEntity && targetId) {
        // La clave aquí es pasar UN SOLO objeto a createJob
        const job = await jobService.createJob({
          source: 'HUBSPOT',
          entity: internalEntity,        // Usamos tu variable internalEntity
          entityId: targetId.toString(),
          eventType: event.subscriptionType,
          payload: event
        });

        console.log(`✅ Job creado en BD [${job._id}] para ${internalEntity} ID: ${targetId}`);
      }
    }

    return reply.code(200).send({ status: 'success' });
  } catch (error) {
    console.error('❌ Error en controlador HS:', error);
    return reply.code(500).send({ status: 'error' });
  }
}

// Nota: handleHubspotDealWebhook se mantiene solo si es para disparos manuales/pruebas.
async function handleHubspotDealWebhook(request, reply) {
  const { dealId } = request.body;
  if (!dealId) return reply.status(400).send({ error: 'Falta dealId' });
  
  // Para pruebas manuales, llamamos al servicio directamente.
  const webhookService = require('../services/webhook.service');
  const result = await webhookService.processDealWebhook(dealId);
  return reply.status(200).send(result);
}

module.exports = { 
  handleQuickBooksWebhook, 
  handleHubSpotWebhook, 
  handleHubspotDealWebhook 
};