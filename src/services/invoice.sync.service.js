// src/services/invoice.sync.service.js
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service');
const productSyncService = require('./product.sync.service');
const mappingService = require('./mapping.service');
const qbMapper = require('../integrations/quickbooks/quickbooks.mapper');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

/**
 * Resuelve el QB Item ID para un Line Item de HubSpot.
 * Estrategia:
 *   1. Si el line item ya tiene `id_producto_quickbooks` → usar directamente
 *   2. Si tiene `hs_product_id` → delegar al servicio de productos
 *   3. Fallback → buscar/crear el item en QB por nombre
 */
async function resolveQbItemIdForLineItem(item, tenantId) {
  const props = item.properties || {};

  // Camino 1: Ya tiene el ID de QB guardado — validar que el item siga activo
  if (props.id_producto_quickbooks) {
    const qbItem = await quickbooksClient.getItemById(props.id_producto_quickbooks).catch(() => null);
    if (qbItem && qbItem.Active !== false) return props.id_producto_quickbooks;
    logger.warn(`⚠️ Item QB ${props.id_producto_quickbooks} inactivo o eliminado. Re-resolviendo...`);
  }

  // Camino 2: Tiene referencia al Producto HS → usamos processProduct
  if (props.hs_product_id) {
    const result = await productSyncService.processProduct(props.hs_product_id, tenantId);
    if (result && result.qbItemId) return result.qbItemId;
  }

  // Camino 3: Fallback por nombre directo en QB
  const itemName = props.name || `Product-LI-${item.id}`;
  logger.info(`🔍 Buscando producto en QB por nombre: "${itemName}"...`);
  let qbItem = await quickbooksClient.findItemByName(itemName).catch(() => null);
  if (qbItem) return qbItem.Id;

  // Último recurso: Crear el item en QB
  logger.info(`✨ Creando producto "${itemName}" en QuickBooks como fallback...`);
  const Tenant = require('../db/models/tenant.model');
  const tenant = await Tenant.findOne({ tenantId });
  const incomeAccountId = tenant?.preferences?.incomeAccountId || '79';

  const newItem = await quickbooksClient.createItem({
    Name: itemName,
    Type: 'Service',
    UnitPrice: props.price ? Number(props.price) : 0,
    IncomeAccountRef: { value: incomeAccountId }
  });
  return newItem.Id;
}

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
    const contactResult = await contactSyncService.processContact(contactId, tenantId);
    if (!contactResult?.qbCustomerId) throw new Error(`No se pudo resolver el Customer Ref para ${contactId}`);
    const { qbCustomerId, contactInfo } = contactResult;

    // 4. Resolución de PRODUCTOS (Line Items)
    logger.info(`📦 Procesando ${lineItemAssociations.length} Line Items...`);
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
    const qbInvoiceLines = [];

    for (const item of lineItemsData) {
      const qbItemId = await resolveQbItemIdForLineItem(item, tenantId);
      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId);
      qbInvoiceLines.push(mappedLine);
    }

    // 5. Mapeo y Creación en QB
    const Tenant = require('../db/models/tenant.model');
    const tenant = await Tenant.findOne({ tenantId });
    const utcOffsetMs = tenant?.hubspot?.utcOffsetMilliseconds || 0;

    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo, utcOffsetMs);
    
    logger.info(`📝 Creando factura en QuickBooks...`);
    const newQbInvoice = await quickbooksClient.createInvoice(qbInvoicePayload);
    const qbInvoiceId = newQbInvoice.Id;

    // 6. Registro de Mapping
    await mappingService.upsertMapping({
      tenantId,
      entityType: 'invoice',
      hsId: invoiceId,
      qbId: qbInvoiceId,
      qbSyncToken: newQbInvoice.SyncToken,
      sourceSystem: 'HUBSPOT'
    });

    // 7. Feedback a HubSpot: solo los datos que QB genera (IDs y referencia)
    const updateProps = {
      id_factura_quickbooks: qbInvoiceId.toString(),
      numero_factura_qb: newQbInvoice.DocNumber,
      sistema_de_origen: 'Quickbooks',
      estado_de_la_factura: 'Emitida'
    };

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
 * --- QB -> HS (Factura enviada al cliente) ---
 * Se dispara cuando QB notifica que la factura fue enviada por email.
 * En ese momento los créditos del customer ya saldaron la factura en QB.
 */
async function handleInvoiceEmailed(qbInvoiceId, tenantId = DEFAULT_TENANT_ID) {
  logger.info(`[Sync] Factura QB ${qbInvoiceId} enviada al cliente -> actualizando HS`, { source: 'QUICKBOOKS', entity: 'invoice', entityId: qbInvoiceId, tenantId });

  const mapping = await mappingService.findByQbId(tenantId, 'invoice', qbInvoiceId);
  if (!mapping || !mapping.hsId) {
    logger.warn(`⚠️ Factura QB ${qbInvoiceId} sin mapeo en HS. Omitiendo.`);
    return;
  }

  await hubspotClient.updateInvoice(mapping.hsId, {
    factura_enviada_al_cliente: 'Si',
    estado_de_la_factura: 'Pagada'
  });

  logger.info(`✅ Factura HS ${mapping.hsId} marcada como enviada y pagada.`);
}

module.exports = {
  syncInvoiceToQuickbooks,
  handleInvoiceEmailed
};