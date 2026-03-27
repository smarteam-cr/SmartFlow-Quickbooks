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

    // QuickBooks envía un arreglo de notificaciones (eventNotifications)
    if (payload.eventNotifications && payload.eventNotifications.length > 0) {
      for (const notification of payload.eventNotifications) {
        
        // Cada notificación trae entidades que fueron creadas o actualizadas
        const entities = notification.dataChangeEvent.entities;
        
        for (const entity of entities) {
          // Evaluamos si la entidad es un Pago (Payment) y si es nuevo o actualizado
          if (entity.name === 'Payment' && (entity.operation === 'Create' || entity.operation === 'Update')) {
            const paymentId = entity.id;
            console.log(`\n=== [Webhook] Procesando evento de PAGO (QBO) ID: ${paymentId} ===`);
            
            // Lo enviamos a nuestro nuevo orquestador de pagos sin el "await" 
            // para no bloquear la respuesta rápida (200 OK) que exige QuickBooks
            paymentSyncService.processQuickbooksPayment(paymentId).catch(err => {
              console.error('Error en el proceso en segundo plano de pagos:', err.message);
            });
            console.log('=================================================');
          }
          // Aquí en el futuro puedes agregar más "else if" para escuchar Invoice, Customer, etc.
          // else if (entity.name === 'Invoice') { ... }
        }
      }
    }

    // Retornamos 200 INMEDIATAMENTE para que Intuit no nos marque timeout
    return reply.status(200).send('Webhook de QuickBooks recibido y enrutado');
  } catch (error) {
    console.error('Error en el controlador de QuickBooks:', error);
    return reply.status(500).send('Error interno del servidor');
  }
}

const handleHubSpotWebhook = async (request, reply) => {
  try {
    const events = request.body;
    
    // 1. TRAMPA DE DEPURACIÓN: Imprimir TODO lo que llega de HubSpot
    console.log('\n======================================================');
    console.log('🔔 WEBHOOK RECIBIDO DESDE HUBSPOT');
    console.log(JSON.stringify(events, null, 2));
    console.log('======================================================\n');

    for (const event of events) {
      if (event.subscriptionType === 'contact.creation') {
        const contactId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nuevo contacto ID: ${contactId} ===`);
        await contactSyncService.processContact(contactId);
        console.log('=================================================');
      } 
      else if (event.subscriptionType === 'company.creation') {
        const companyId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nueva EMPRESA ID: ${companyId} ===`);
        await companySyncService.processCompany(companyId);
        console.log('=================================================');
      }
      else if (event.subscriptionType === 'product.creation') {
        const productId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nuevo PRODUCTO ID: ${productId} ===`);
        await productSyncService.syncProductToQuickbooks(productId);
        console.log('=================================================');
      }
      // 2. CAMBIO AQUÍ: Ahora buscamos 'object.creation' en lugar de 'invoice.creation'
      else if (event.subscriptionType === 'object.creation') {
        const invoiceId = event.objectId;
        console.log(`\n=== [Webhook] Procesando nueva FACTURA (Object) ID: ${invoiceId} ===`);
        invoiceSyncService.syncInvoiceToQuickbooks(invoiceId).catch(err => {
          console.error('Fallo en el proceso de fondo de la factura:', err.message);
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