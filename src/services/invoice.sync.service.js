// src/services/invoice.sync.service.js
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service');
const productSyncService = require('./product.sync.service');
const mappingService = require('./mapping.service');
const qbMapper = require('../integrations/quickbooks/quickbooks.mapper');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

/**
 * --- HS -> QB (Facturas) ---
 * Se dispara cuando una factura está marcada como pagada en HS.
 */
async function syncInvoiceToQuickbooks(invoiceId, tenantId = DEFAULT_TENANT_ID) {
  logger.info(`[Sync] Sincronización Factura HS ID: ${invoiceId}`, { source: 'HUBSPOT', entity: 'invoice', entityId: invoiceId, tenantId });

  try {
    // 1. Verificar si ya existe el mapeo
    const mapping = await mappingService.findByHsId(tenantId, 'invoice', invoiceId);
    if (mapping && mapping.qbId) {
      logger.info(`ℹ️ Factura HS ${invoiceId} ya tiene mapping (QB ID: ${mapping.qbId}). Omitiendo creación.`);
      return mapping.qbId;
    }

    // 2. Obtener la factura y validar reglas de negocio
    const hsInvoice = await hubspotClient.getInvoiceDetails(invoiceId);
    if (!hsInvoice) throw new Error(`La factura ${invoiceId} no existe en HubSpot.`);

    const balance = Number(hsInvoice.properties.hs_balance_due || 0);
    if (balance > 0) {
      logger.warn(`🛑 [Regla] Factura ${invoiceId} con saldo pendiente (${balance}). No se sincroniza.`);
      return null;
    }

    const lineItemAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'line_items');
    if (lineItemAssociations.length === 0) {
      logger.warn(`🛑 [Regla] Factura ${invoiceId} sin productos. Omitiendo.`);
      return null;
    }

    // 3. Resolución de CONTACTO
    const contactAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'contacts');
    if (contactAssociations.length === 0) {
      throw new Error(`La factura ${invoiceId} no tiene un Contacto asociado.`);
    }

    const contactId = contactAssociations[0];
    const { qbCustomerId, contactInfo } = await contactSyncService.processContact(contactId, tenantId);
    if (!qbCustomerId) throw new Error(`No se pudo resolver el Customer Ref para ${contactId}`);

    // 4. Resolución de PRODUCTOS (Line Items)
    logger.info(`📦 Procesando ${lineItemAssociations.length} Line Items...`);
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
    const qbInvoiceLines = [];

    for (const item of lineItemsData) {
      // Usamos el servicio de productos para garantizar que el producto exista y esté mapeado
      const { qbItemId } = await productSyncService.processProduct(item.id, tenantId);
      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId);
      qbInvoiceLines.push(mappedLine);
    }

    // 5. Mapeo y Creación en QB
    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo);
    
    logger.info(`📝 Creando factura en QuickBooks...`);
    const newQbInvoice = await quickbooksClient.createInvoice(qbInvoicePayload);
    const qbInvoiceId = newQbInvoice.Id;

    echoSuppression.markAsCreatedInQb(qbInvoiceId);

    // 6. Registro de Mapping
    const qbTaxAmount = newQbInvoice.TxnTaxDetail?.TotalTax || 0;
    
    await mappingService.upsertMapping({
      tenantId,
      entityType: 'invoice',
      hsId: invoiceId,
      qbId: qbInvoiceId,
      qbSyncToken: newQbInvoice.SyncToken,
      sourceSystem: 'HUBSPOT'
    });

    // 7. Feedback a HubSpot (Propiedades espejo)
    const updateProps = {
      id_factura_quickbooks: qbInvoiceId.toString(),
      numero_factura_qb: newQbInvoice.DocNumber,
      qb_total_amount: newQbInvoice.TotalAmt.toString(),
      saldo_pendiente_qb: newQbInvoice.Balance.toString(),
      qb_tax_amount: qbTaxAmount.toString(),
      qb_sync_token: newQbInvoice.SyncToken
    };

    echoSuppression.markAsCreatedInHs(invoiceId);
    await hubspotClient.updateInvoice(invoiceId, updateProps);
    
    // 8. Conciliación de Pagos
    const paymentSyncService = require('./payment.sync.service');
    await paymentSyncService.reconcilePaymentsForInvoice(invoiceId, qbInvoiceId, tenantId);

    logger.info(`🎉 Factura sincronizada correctamente: QB ${qbInvoiceId}`);
    return qbInvoiceId;

  } catch (error) {
    logger.error(`❌ Error sincronizando factura HS ${invoiceId}:`, error);
    throw error;
  }
}

/**
 * --- QB -> HS (Actualización de Estado) ---
 */
async function syncInvoiceFromQuickbooks(qbInvoiceId, tenantId = DEFAULT_TENANT_ID) {
  if (echoSuppression.wasCreatedInQb(qbInvoiceId)) return;

  logger.info(`[Sync] Actualizando Factura QB ID: ${qbInvoiceId} -> HS`, { source: 'QUICKBOOKS', entity: 'invoice', entityId: qbInvoiceId, tenantId });

  const qbInvoice = await quickbooksClient.getInvoice(qbInvoiceId).catch(() => null);
  if (!qbInvoice) return;

  const mapping = await mappingService.findByQbId(tenantId, 'invoice', qbInvoiceId);
  const hsInvoiceId = mapping ? mapping.hsId : (await hubspotClient.searchInvoiceByCustomProperty('id_factura_quickbooks', qbInvoiceId))?.id;

  if (!hsInvoiceId) {
    logger.warn(`⚠️ Factura QB ${qbInvoiceId} no encontrada en HubSpot. Omitiendo actualización de saldos.`);
    return;
  }

  // Lógica de saldos y estados
  const amountPaid = qbInvoice.TotalAmt - qbInvoice.Balance;
  const propertiesToUpdate = {
    importe_pagado_qb: amountPaid.toString(),
    saldo_pendiente_qb: qbInvoice.Balance.toString(),
    qb_sync_token: qbInvoice.SyncToken
  };

  if (qbInvoice.Balance === 0) propertiesToUpdate.estado_de_factura_qb = 'Pagada';
  else if (amountPaid > 0) propertiesToUpdate.estado_de_factura_qb = 'Emitida';
  else propertiesToUpdate.estado_de_factura_qb = 'Borrador';

  echoSuppression.markAsCreatedInHs(hsInvoiceId);
  await hubspotClient.updateInvoice(hsInvoiceId, propertiesToUpdate);

  await mappingService.upsertMapping({
    tenantId, 
    entityType: 'invoice', 
    hsId: hsInvoiceId, 
    qbId: qbInvoiceId,
    qbSyncToken: qbInvoice.SyncToken,
    sourceSystem: 'QUICKBOOKS'
  });
}

/**
 * --- HS -> QB (Update) ---
 */
async function syncHubSpotInvoiceToQuickbooks(invoiceId, tenantId = DEFAULT_TENANT_ID) {
  if (echoSuppression.wasCreatedInHs(invoiceId)) return;

  logger.info(`[Sync] Actualizando Factura HS ID: ${invoiceId} -> QB`);

  const hsInvoice = await hubspotClient.getInvoiceDetails(invoiceId);
  if (!hsInvoice) return;

  const mapping = await mappingService.findByHsId(tenantId, 'invoice', invoiceId);
  if (!mapping || !mapping.qbId) return;

  const qbInvoiceId = mapping.qbId;

  // 🛡️ REGLA: Bloqueo contable
  const currentStatus = hsInvoice.properties.estado_de_factura_qb;
  if (currentStatus && !['Abierta', 'Borrador', ''].includes(currentStatus)) {
    logger.warn(`🛑 Bloqueo Contable: Factura HS ${invoiceId} está en estado "${currentStatus}". No se puede editar.`);
    return;
  }

  // 🛡️ FIX: SyncToken Fresco
  const existingQb = await quickbooksClient.getInvoice(qbInvoiceId).catch(() => null);
  if (!existingQb) return;

  // Re-resolver asociación de contacto si es necesario
  const contactAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'contacts');
  const contactId = contactAssociations[0];
  const { qbCustomerId, contactInfo } = await contactSyncService.processContact(contactId, tenantId);

  // Re-resolver line items
  const lineItemAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'line_items');
  const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
  const qbInvoiceLines = [];

  for (const item of lineItemsData) {
    const { qbItemId } = await productSyncService.processProduct(item.id, tenantId);
    qbInvoiceLines.push(qbMapper.mapLineItemToQb(item, qbItemId));
  }

  const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo);

  logger.info(`📝 Enviando actualización a QuickBooks (QB ID: ${qbInvoiceId})...`);
  echoSuppression.markAsCreatedInQb(qbInvoiceId);
  const updated = await quickbooksClient.updateInvoice(qbInvoiceId, existingQb.SyncToken, qbInvoicePayload);

  await mappingService.upsertMapping({
    tenantId, entityType: 'invoice', hsId: invoiceId, qbId: qbInvoiceId,
    qbSyncToken: updated.SyncToken, sourceSystem: 'HUBSPOT'
  });
}

module.exports = {
  syncInvoiceToQuickbooks,
  syncInvoiceFromQuickbooks,
  syncHubSpotInvoiceToQuickbooks
};