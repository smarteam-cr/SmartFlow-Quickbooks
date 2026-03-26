const config = require('../config');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const productSyncService = require('./product.sync.service'); // Importamos el orquestador de productos

/**
 * Procesa el payload (cuerpo) del webhook que envía QuickBooks.
 * Enruta los eventos según el tipo de entidad (Payment, Item, etc.).
 */
async function processPaymentNotification(payload) {
    try {
        const notificaciones = payload.eventNotifications;

        if (!notificaciones || notificaciones.length === 0) return;

        for (const notificacion of notificaciones) {
            const realmId = notificacion.realmId;
            const eventos = notificacion.dataChangeEvent.entities;

            for (const evento of eventos) {
                // 1. Enrutador para Pagos (Lógica existente)
                if (evento.name === 'Payment' && evento.operation === 'Create') {
                    const paymentId = evento.id;
                    console.log(`[Service] Procesando nuevo pago con ID: ${paymentId} para el cliente ${realmId}`);

                    const accessToken = config.quickbooks.accessToken;
                    const detallesPago = await quickbooksClient.getPaymentDetails(realmId, paymentId, accessToken);

                    console.log('[Service] ¡Pago extraído exitosamente de QuickBooks!');
                    console.log('Monto:', detallesPago.Payment.TotalAmt);
                    console.log('Cliente Ref:', detallesPago.Payment);
                }
                
                // 2. Enrutador para Productos / Items (NUEVA LÓGICA TAREA 2.2)
                else if (evento.name === 'Item' && evento.operation === 'Create') {
                    const qbItemId = evento.id;
                    console.log(`\n=== [Webhook] Procesando nuevo ITEM de QuickBooks ID: ${qbItemId} ===`);
                    await productSyncService.syncProductFromQuickbooks(qbItemId);
                    console.log('=================================================');
                }
            }
        }
    } catch (error) {
        console.error('[Service] Error procesando el webhook de QuickBooks:', error.message);
        throw error; 
    }
}

async function processDealWebhook(dealId) {
  try {
    console.log(`\n[Webhook Service] Iniciando procesamiento para el Negocio ID: ${dealId}`);
    
    const dealDetails = await hubspotClient.getDealDetails(dealId);
    console.log(`[HubSpot] Negocio encontrado: ${dealDetails.properties.dealname} | Monto Total: $${dealDetails.properties.amount}`);

    const lineItems = await hubspotClient.getLineItemsByDealId(dealId);
    console.log(`[HubSpot] Se encontraron ${lineItems.length} productos (Line Items) asociados.`);
    
    lineItems.forEach((item, index) => {
      console.log(`   ${index + 1}. Producto: ${item.properties.name} | Precio: $${item.properties.price} | Cantidad: ${item.properties.quantity}`);
    });

    return { 
      success: true, 
      dealName: dealDetails.properties.dealname,
      amount: dealDetails.properties.amount,
      items: lineItems.map(i => ({ name: i.properties.name, price: i.properties.price }))
    };

  } catch (error) {
    console.error(`[Webhook Service] Error procesando el negocio ${dealId}:`, error.message);
    throw error;
  }
}

module.exports = { processPaymentNotification, processDealWebhook };