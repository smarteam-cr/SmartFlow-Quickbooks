// src/services/invoice.sync.service.js
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service');
const productSyncService = require('./product.sync.service');
const mappingService = require('./mapping.service');
const qbMapper = require('../integrations/quickbooks/quickbooks.mapper');
const Tenant = require('../db/models/tenant.model');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID, CONTACT_STATUS_VALUES } = require('../config/constants');
const { InactiveCustomerError } = require('../utils/errors.util');

/**
 * Resuelve el QB Item ID y su SalesTaxCodeRef para un Line Item de HubSpot.
 * Retorna { qbItemId, qbSalesTaxCodeId }.
 * Estrategia para qbItemId:
 *   1. Si el line item ya tiene `id_producto_quickbooks` → usar directamente
 *   2. Si tiene `hs_product_id` → delegar al servicio de productos
 *   3. Fallback → buscar el item en QB por nombre
 * Siempre se termina con un `getItemById` para extraer SalesTaxCodeRef,
 * que se usa luego para la validación estricta de tax.
 */
async function resolveQbItemIdForLineItem(item, tenantId) {
  const props = item.properties || {};
  let qbItemId = null;

  // Camino 1: Ya tiene el ID de QB guardado — validar que el item siga activo
  if (props.id_producto_quickbooks) {
    const existing = await quickbooksClient.getItemById(props.id_producto_quickbooks).catch(() => null);
    if (existing && existing.Active !== false) {
      qbItemId = props.id_producto_quickbooks;
    } else {
      logger.warn(`⚠️ Item QB ${props.id_producto_quickbooks} inactivo o eliminado. Re-resolviendo...`);
    }
  }

  // Camino 2: Tiene referencia al Producto HS → usamos processProduct
  if (!qbItemId && props.hs_product_id) {
    const result = await productSyncService.processProduct(props.hs_product_id, tenantId);
    if (result && result.qbItemId) qbItemId = result.qbItemId;
  }

  // Camino 3: Fallback por nombre directo en QB
  if (!qbItemId) {
    const itemName = props.name || `Product-LI-${item.id}`;
    logger.info(`🔍 Buscando producto en QB por nombre: "${itemName}"...`);
    const byName = await quickbooksClient.findItemByName(itemName).catch(() => null);
    if (byName) qbItemId = byName.Id;
  }

  if (!qbItemId) {
    const itemName = props.name || `Product-LI-${item.id}`;
    throw new Error(`Producto "${itemName}" no encontrado en QuickBooks. Créalo en QB y vuelve a intentarlo.`);
  }

  // Obtener SalesTaxCodeRef del item para validación de tax
  const qbItem = await quickbooksClient.getItemById(qbItemId);
  const qbSalesTaxCodeId = qbItem?.SalesTaxCodeRef?.value;
  if (!qbSalesTaxCodeId) {
    throw new Error(`QB Item ${qbItemId} no tiene SalesTaxCodeRef configurado. Configura el tax del producto en QuickBooks.`);
  }

  return { qbItemId, qbSalesTaxCodeId };
}

/**
 * Valida que el tax seleccionado en la línea de HS coincida con el tax
 * del item en QB, usando taxMappings del tenant como tabla de traducción.
 * Lanza Error con detalle si hay discrepancia — aborta la creación de la factura.
 */
function validateLineTax(item, qbItemId, qbSalesTaxCodeId, taxMappings) {
  const hsTaxId = item.properties?.hs_tax_rate_group_id;

  if (!hsTaxId) {
    throw new Error(`Line item ${item.id} sin hs_tax_rate_group_id. El usuario debe seleccionar una tasa en HS.`);
  }

  const expectedHsTaxId = Object.keys(taxMappings).find(k => taxMappings[k] === qbSalesTaxCodeId);
  if (!expectedHsTaxId) {
    throw new Error(`QB item ${qbItemId} usa TaxCode ${qbSalesTaxCodeId} que no está en taxMappings del tenant. Ejecuta configure-tax-mappings.js para registrarlo.`);
  }

  if (hsTaxId !== expectedHsTaxId) {
    const hsMappedTo = taxMappings[hsTaxId] || '(sin mapeo)';
    throw new Error(
      `Tax mismatch en line item ${item.id}: HS envía "${hsTaxId}" (→ QB ${hsMappedTo}), pero QB item ${qbItemId} tiene TaxCode ${qbSalesTaxCodeId} (← HS esperado "${expectedHsTaxId}").`
    );
  }
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
    const { qbCustomerId, contactInfo, status: contactStatus } = contactResult;

    // Fail-fast: si el contacto está inactivo, abortamos sin golpear QB.
    if (contactStatus === CONTACT_STATUS_VALUES.INACTIVE) {
      throw new InactiveCustomerError(`Factura HS ${invoiceId}: contacto ${contactId} está inactivo. No se crea la factura en QB.`);
    }

    // 4. Cargar tenant (para utcOffset + taxMappings)
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) throw new Error(`Tenant ${tenantId} no encontrado.`);

    const taxMappings = {};
    const rawTaxMappings = tenant.preferences?.taxMappings;
    if (rawTaxMappings instanceof Map) {
      for (const [k, v] of rawTaxMappings.entries()) taxMappings[k] = v;
    } else if (rawTaxMappings && typeof rawTaxMappings === 'object') {
      Object.assign(taxMappings, rawTaxMappings);
    }
    if (Object.keys(taxMappings).length === 0) {
      throw new Error(`Tenant ${tenantId} sin taxMappings configurados. Ejecuta configure-tax-mappings.js antes de sincronizar facturas.`);
    }

    const utcOffsetMs = tenant?.hubspot?.utcOffsetMilliseconds || 0;

    // 5. Resolución de PRODUCTOS + validación estricta de tax por línea
    logger.info(`📦 Procesando ${lineItemAssociations.length} Line Items...`);
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
    const qbInvoiceLines = [];

    for (const item of lineItemsData) {
      const { qbItemId, qbSalesTaxCodeId } = await resolveQbItemIdForLineItem(item, tenantId);
      validateLineTax(item, qbItemId, qbSalesTaxCodeId, taxMappings);
      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId, qbSalesTaxCodeId);
      qbInvoiceLines.push(mappedLine);
    }

    // Leer el customer de QB para heredar terms, email y método de pago en la factura.
    // QB no los autocompleta por API (solo la UI lo hace), así que los copiamos explícitamente.
    const qbCustomer = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);

    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo, utcOffsetMs, qbCustomer);
    
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