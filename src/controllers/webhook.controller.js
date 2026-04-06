const webhookService = require('../services/webhook.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const invoiceSyncService = require('../services/invoice.sync.service');
const paymentSyncService = require('../services/payment.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const mutex = require('../utils/mutex.util');
const jobService = require('../services/job.service');

async function handleQuickBooksWebhook(request, reply) {
  try {
    console.log('\n======================================================');
    console.log('🔔 WEBHOOK RECIBIDO DESDE QUICKBOOKS');
    console.log('======================================================\n');


    const payload = request.body;

    if (payload.eventNotifications && payload.eventNotifications.length > 0) {
      for (const notification of payload.eventNotifications) {
        const entities = notification.dataChangeEvent.entities;

        for (const entity of entities) {       
          if (entity.name === 'Payment' && (entity.operation === 'Create' || entity.operation === 'Update')) {
            const paymentId = entity.id;
            console.log(`\n=== [Webhook] Procesando evento de PAGO (QBO) ID: ${paymentId} ===`);

            paymentSyncService.processQuickbooksPayment(paymentId).catch(err => {
              console.error('Error en el proceso en segundo plano de pagos:', err.message);
            });
            console.log('=================================================');
          }
          else if (entity.name === 'Item' && (entity.operation === 'Create' || entity.operation === 'Update')) {
            const itemId = entity.id;
            console.log(`\n=== [Webhook] Procesando evento de PRODUCTO/ITEM (QBO) ID: ${itemId} ===`);

            productSyncService.syncProductFromQuickbooks(itemId).catch(err => {
              console.error('Error en el proceso en segundo plano de productos:', err.message);
            });
            console.log('=================================================');
          }
          else if (entity.name === 'Invoice' && (entity.operation === 'Create' || entity.operation === 'Update' || entity.operation === 'Emailed')) {
            const invoiceId = entity.id;
            console.log(`\n=== [Webhook] Procesando evento de FACTURA (QBO) ID: ${invoiceId} ===`);
            
            invoiceSyncService.syncInvoiceFromQuickbooks(invoiceId).catch(err => {
              console.error('Error en el proceso en segundo plano de facturas:', err.message);
            });
            console.log('=================================================');
          }
          else if (entity.name === 'Customer' && (entity.operation === 'Create' || entity.operation === 'Update')) {
            const customerId = entity.id;
            console.log(`\n=== [Webhook] Procesando evento de CLIENTE (QBO) ID: ${customerId} ===`);
            
            contactSyncService.syncCustomerFromQuickbooks(customerId).catch(err => {
              console.error('Error en el proceso en segundo plano de clientes:', err.message);
            });
            console.log('=================================================');
          }
        }
      }
    }

    return reply.status(200).send('Webhook de QuickBooks recibido y enrutado');
  } catch (error) {
    console.error('Error en el controlador de QuickBooks:', error);
    return reply.status(500).send('Error interno del servidor');
  }
}

const handleHubSpotWebhook = async (request, reply) => {
  try {
    const events = request.body;

    for (const event of events) {
      try {
        const targetId = event.fromObjectId || event.objectId;

        if (!targetId) {
          console.warn(`⚠️ Evento ${event.subscriptionType} ignorado por falta de ID.`);
          continue;
        }

        // Determinamos la entidad
        const entityMap = {
          'contact.creation': 'contact',
          'contact.propertyChange': 'contact',
          'contact.associationChange': 'contact',
          'company.creation': 'company',
          'company.propertyChange': 'company',
          'product.creation': 'product',
          'product.propertyChange': 'product',
          'deal.creation': 'invoice',
          'deal.propertyChange': 'invoice',
        };

        const entity = entityMap[event.subscriptionType];

        if (!entity) {
          console.warn(`⚠️ Tipo de evento no mapeado: ${event.subscriptionType}`);
          continue;
        }

        // Guardamos el job en BD y respondemos 200 de inmediato
        const job = await jobService.createJob(
          entity,
          targetId,
          event.subscriptionType,
          event
        );

        console.log(`✅ Job creado en BD [${job._id}] para ${entity} ID: ${targetId}`);

      } catch (err) {
        console.error(`❌ Error guardando job para evento:`, err.message);
      }
    }

    return reply.code(200).send({ status: 'success' });

  } catch (error) {
    console.error('💥 Error crítico en controlador:', error);
    return reply.code(500).send({ status: 'error' });
  }
};

async function handleHubspotDealWebhook(request, reply) {
  try {
    const { dealId } = request.body;

    if (!dealId) {
      return reply.status(400).send({ error: 'Falta proveer el dealId en el body' });
    }

    const result = await webhookService.processDealWebhook(dealId);
    return reply.status(200).send(result);

  } catch (error) {
    console.error('Error en el controlador handleHubspotDealWebhook:', error.message);
    return reply.status(500).send({ error: 'Error interno procesando el webhook de HubSpot' });
  }
}

module.exports = { handleQuickBooksWebhook, handleHubSpotWebhook, handleHubspotDealWebhook };