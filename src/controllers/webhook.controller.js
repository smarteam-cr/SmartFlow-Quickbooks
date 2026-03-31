const webhookService = require('../services/webhook.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const invoiceSyncService = require('../services/invoice.sync.service');
const paymentSyncService = require('../services/payment.sync.service');

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
    
    console.log('\n======================================================');
    console.log('🔔 WEBHOOK RECIBIDO DESDE HUBSPOT');
    console.log(JSON.stringify(events, null, 2));
    console.log('======================================================\n');

    for (const event of events) {
      if (event.subscriptionType === 'contact.creation') {
        const contactId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nuevo CONTACTO ID: ${contactId} ===`);
        await contactSyncService.processContact(contactId);
      } 
      else if (event.subscriptionType === 'company.creation') {
        const companyId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nueva EMPRESA ID: ${companyId} ===`);
        await companySyncService.processCompany(companyId);
      }
      else if (event.subscriptionType === 'product.creation') {
        const productId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nuevo PRODUCTO ID: ${productId} ===`);
        await productSyncService.syncProductToQuickbooks(productId);
      }
      else if (event.subscriptionType === 'deal.creation') {
        const dealId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nuevo NEGOCIO ID: ${dealId} ===`);
        webhookService.processDealWebhook(dealId).catch(err => {
          console.error('Fallo en el proceso de fondo del negocio:', err.message);
        });
      }
    }

    return reply.code(200).send({ status: 'success' });
  } catch (error) {
    console.error('Error al procesar el webhook de HubSpot:', error);
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