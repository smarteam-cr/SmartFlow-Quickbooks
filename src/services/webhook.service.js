const config = require('../config');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const productSyncService = require('./product.sync.service');
const invoiceSyncService = require('./invoice.sync.service');
const logger = require('../lib/logger.lib');

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
          logger.info(`[QB Webhook] Procesando nuevo pago ID: ${paymentId} para cliente: ${realmId}`, { source: 'QUICKBOOKS', entity: 'payment', entityId: paymentId });

          const detallesPago = await quickbooksClient.getPaymentDetails(paymentId);

          logger.info('[QB Webhook] ¡Pago extraído exitosamente de QuickBooks!', { amount: detallesPago.TotalAmt, customerRef: detallesPago.CustomerRef });
        }

        // 2. Enrutador para Productos / Items (NUEVA LÓGICA TAREA 2.2)
        else if (evento.name === 'Item' && evento.operation === 'Create') {
          const qbItemId = evento.id;
          logger.info(`[QB Webhook] Procesando nuevo ITEM ID: ${qbItemId}`, { source: 'QUICKBOOKS', entity: 'product', entityId: qbItemId });
          await productSyncService.syncProductFromQuickbooks(qbItemId);
        }
      }
    }
  } catch (error) {
    logger.error('[QB Webhook] Error procesando el webhook de QuickBooks:', error);
    throw error;
  }
}

/**
 * Procesa webhooks de Facturas de HubSpot (Objeto 0-53).
 */
async function processHubSpotInvoiceWebhook(objectId, subscriptionType, propertyName) {
  try {
    logger.info(`[HubSpot Webhook] Recibido evento ${subscriptionType} para Factura ID: ${objectId}`, { source: 'HUBSPOT', entity: 'invoice', entityId: objectId });

    // Evitamos bucles infinitos si el cambio es en estados que nosotros mismos actualizamos
    const propertiesToIgnore = ['id_factura_quickbooks', 'estado_de_factura_qb', 'importe_pagado_qb', 'saldo_pendiente_qb'];
    if (subscriptionType === 'object.propertyChange' && propertiesToIgnore.includes(propertyName)) {
      logger.info(`[HubSpot Webhook] Cambio en propiedad ignorada (${propertyName}) para Factura ID: ${objectId}. Omitiendo.`);
      return;
    }

    // Disparamos la actualización hacia QuickBooks
    await invoiceSyncService.syncHubSpotInvoiceToQuickbooks(objectId);

  } catch (error) {
    logger.error(`[HubSpot Webhook] Error procesando factura ${objectId}:`, error);
  }
}

/**
 * Procesa webhooks de Partidas de HubSpot (Line Items 0-27).
 * Identifica la factura asociada y refresca la info en QuickBooks.
 */
async function processHubSpotLineItemWebhook(lineItemId) {
  try {
    logger.info(`[HubSpot Webhook] Cambio detectado en Line Item ID: ${lineItemId}`, { source: 'HUBSPOT', entity: 'line_item', entityId: lineItemId });

    // 1. Buscar a qué factura pertenece esta partida
    const associatedInvoices = await hubspotClient.getLineItemAssociations(lineItemId, 'invoices');
    
    if (associatedInvoices.length === 0) {
      logger.info(`[HubSpot Webhook] El Line Item ${lineItemId} no está asociado a ninguna factura aún.`);
      return;
    }

    // 2. Refrescar cada factura asociada
    for (const invoiceId of associatedInvoices) {
      logger.info(`[HubSpot Webhook] Refrescando Factura ID: ${invoiceId} debido a cambio en Line Item: ${lineItemId}`);
      await invoiceSyncService.syncHubSpotInvoiceToQuickbooks(invoiceId);
    }

  } catch (error) {
    logger.error(`[HubSpot Webhook] Error procesando Line Item ${lineItemId}:`, error);
  }
}

module.exports = { 
  processPaymentNotification, 
  processHubSpotInvoiceWebhook,
  processHubSpotLineItemWebhook
};