const webhookService = require('../services/webhook.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const invoiceSyncService = require('../services/invoice.sync.service');
const paymentSyncService = require('../services/payment.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const mutex = require('../utils/mutex.util');

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
        // 🌟 CLAVE: Si es asociación usa fromObjectId, si no usa objectId
        const targetId = event.fromObjectId || event.objectId;

        if (!targetId) {
          console.warn(`⚠️ Evento ${event.subscriptionType} ignorado por falta de ID.`);
          continue;
        }

        if (
          event.subscriptionType === 'contact.creation' ||
          event.subscriptionType === 'contact.propertyChange' ||
          event.subscriptionType === 'contact.associationChange'
        ) {
          // 1. SUPRESIÓN DE ECO (Contactos)
          if (echoSuppression.wasCreatedInHs(targetId)) {
            console.log(`♻️ [Echo] Ignorando contacto ${targetId} (cambio interno).`);
            continue;
          }

          // 2. FILTRO DE PROPIEDADES (Contactos)
          if (event.subscriptionType === 'contact.propertyChange') {
            const mappedProps = ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'];
            if (!mappedProps.includes(event.propertyName)) continue;
          }

          // 3. PROCESAMIENTO (Contactos)
          console.log(`⏱️ Encolando Sincronización para Contacto ${targetId} (${event.subscriptionType})...`);
          contactSyncService.processContact(targetId).catch(err => {
            console.error(`❌ Error sincronizando contacto ${targetId}:`, err.message);
          });
        } 
        else if (
          event.subscriptionType === 'company.creation' ||
          event.subscriptionType === 'company.propertyChange'
        ) {
          // 1. SUPRESIÓN DE ECO (Empresas)
          if (echoSuppression.wasCreatedInHs(targetId)) {
            console.log(`♻️ [Echo] Ignorando empresa ${targetId} (cambio interno).`);
            continue;
          }

          // 2. FILTRO DE PROPIEDADES (Empresas)
          if (event.subscriptionType === 'company.propertyChange') {
            const mappedProps = ['name', 'nit', 'phone', 'domain', 'address', 'city', 'country'];
            if (!mappedProps.includes(event.propertyName)) continue;
          }

          // 3. PROCESAMIENTO (Empresas)
          console.log(`⏱️ Encolando Sincronización para Empresa ${targetId} (${event.subscriptionType})...`);
          companySyncService.processCompany(targetId).catch(err => {
            console.error(`❌ Error sincronizando empresa ${targetId}:`, err.message);
          });
        }
        else if (
          event.subscriptionType === 'product.creation' ||
          event.subscriptionType === 'product.propertyChange'
        ) {
          // 1. SUPRESIÓN DE ECO (Productos)
          if (echoSuppression.wasCreatedInHs(targetId)) {
            console.log(`♻️ [Echo] Ignorando producto ${targetId} (cambio interno).`);
            continue;
          }

          // 2. FILTRO DE PROPIEDADES (Productos)
          if (event.subscriptionType === 'product.propertyChange') {
            const mappedProps = ['name', 'price', 'hs_price_usd', 'description', 'hs_sku', 'es_gravable'];
            if (!mappedProps.includes(event.propertyName)) continue;
          }

          // 3. PROCESAMIENTO (Productos)
          console.log(`⏱️ Encolando Sincronización para Producto ${targetId} (${event.subscriptionType})...`);
          productSyncService.syncProductToQuickbooks(targetId).catch(err => {
            console.error(`❌ Error sincronizando producto ${targetId}:`, err.message);
          });
        }
      } catch (err) {
        console.error(`❌ Error en evento individual:`, err.message);
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