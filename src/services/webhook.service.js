const config = require('../config');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const productSyncService = require('./product.sync.service');
const invoiceSyncService = require('./invoice.sync.service');

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
      const esGravable = item.properties.es_gravable === "true" ? "SÍ" : "NO";

      console.log(`   ${index + 1}. Producto: ${item.properties.name} | Precio: $${item.properties.price} | Cantidad: ${item.properties.quantity} | ¿Lleva Impuesto?: ${esGravable}`);
    });

    console.log(`\n[Workaround] Disparando sincronización de factura simulada...`);

    // TODO: CAMBIAR ESTE ID EN CADA PRUEBA CLONANDO LA FACTURA EN HUBSPOT
    const idFacturaDePrueba = '545773692265';

    // 1. OBTENER CONTACTOS DE LA FACTURA
    console.log(`[HubSpot] Obteniendo contactos asociados a la factura ${idFacturaDePrueba}...`);
    const associatedContacts = await hubspotClient.getInvoiceAssociations(idFacturaDePrueba, 'contacts');
    console.log(`[HubSpot] Encontrados ${associatedContacts.length} contactos asociados a la factura.`);

    // 2. ASOCIAR FACTURA AL NEGOCIO (CRM Association)
    console.log(`[HubSpot] Asociando factura ${idFacturaDePrueba} con el Negocio ${dealId}...`);
    await hubspotClient.associateInvoiceToDeal(idFacturaDePrueba, dealId);

    // 3. ASOCIAR FACTURA A LOS CONTACTOS (Asegurar vínculo)
    for (const contactId of associatedContacts) {
      console.log(`[HubSpot] Asegurando vínculo factura ${idFacturaDePrueba} <-> Contacto ${contactId}...`);
      await hubspotClient.associateInvoiceToContact(idFacturaDePrueba, contactId);
    }

    // 3. Sincronizar hacia QuickBooks (Background)
    invoiceSyncService.syncInvoiceToQuickbooks(idFacturaDePrueba).catch(err => {
      console.error(`[Fallo en Segundo Plano] Error sincronizando la factura simulada ${idFacturaDePrueba}:`, err.message);
    });
    // ------------------------------------------

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

/**
 * Procesa webhooks de Facturas de HubSpot (Objeto 0-53).
 */
async function processHubSpotInvoiceWebhook(objectId, subscriptionType, propertyName) {
  try {
    console.log(`\n[HubSpot Webhook] Recibido evento ${subscriptionType} para Factura: ${objectId}`);

    // Evitamos bucles infinitos si el cambio es en estados que nosotros mismos actualizamos
    const propertiesToIgnore = ['id_factura_quickbooks', 'estado_de_factura_qb', 'importe_pagado_qb', 'saldo_pendiente_qb'];
    if (subscriptionType === 'object.propertyChange' && propertiesToIgnore.includes(propertyName)) {
      return;
    }

    // Disparamos la actualización hacia QuickBooks
    await invoiceSyncService.syncHubSpotInvoiceToQuickbooks(objectId);

  } catch (error) {
    console.error(`[HubSpot Webhook] Error procesando factura ${objectId}:`, error.message);
  }
}

/**
 * Procesa webhooks de Partidas de HubSpot (Line Items 0-27).
 * Identifica la factura asociada y refresca la info en QuickBooks.
 */
async function processHubSpotLineItemWebhook(lineItemId) {
  try {
    console.log(`\n[HubSpot Webhook] Cambio detectado en Line Item: ${lineItemId}`);

    // 1. Buscar a qué factura pertenece esta partida
    const associatedInvoices = await hubspotClient.getLineItemAssociations(lineItemId, 'invoices');
    
    if (associatedInvoices.length === 0) {
      console.log(`ℹ️ El Line Item ${lineItemId} no está asociado a ninguna factura aún.`);
      return;
    }

    // 2. Refrescar cada factura asociada
    for (const invoiceId of associatedInvoices) {
      console.log(`🔄 Refrescando Factura ${invoiceId} debido a cambio en sus ítems...`);
      await invoiceSyncService.syncHubSpotInvoiceToQuickbooks(invoiceId);
    }

  } catch (error) {
    console.error(`[HubSpot Webhook] Error procesando Line Item ${lineItemId}:`, error.message);
  }
}

module.exports = { 
  processPaymentNotification, 
  processDealWebhook,
  processHubSpotInvoiceWebhook,
  processHubSpotLineItemWebhook
};