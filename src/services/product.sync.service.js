// src/services/product.sync.service.js
const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const Tenant = require('../db/models/tenant.model');
const { DEFAULT_TENANT_ID } = require('../config/constants');

/**
 * Obtiene la cuenta contable de ingresos configurada para este cliente
 */
async function getIncomeAccountId(tenantId) {
  const tenant = await Tenant.findOne({ tenantId });
  return tenant?.preferences?.incomeAccountId || '79';
}

/**
 * Normalización HS -> QB (Productos a Items)
 * Incluye la transformación del string de HubSpot a Booleano para QB
 */
function normalizeHsProductToQb(hsProduct, incomeAccountId) {
  const props = hsProduct.properties || {};
  const isTaxable = props.es_gravable === 'true' || props.es_gravable === true; 

  return {
    Name: props.name || `Product-${hsProduct.id}`,
    Description: props.description || "",
    UnitPrice: props.price ? Number(props.price) : 0,
    Sku: props.hs_sku || "",
    Type: 'Service', 
    Taxable: isTaxable,
    IncomeAccountRef: {
      value: incomeAccountId
    }
  };
}

/**
 * Normalización QB -> HS (Items a Productos)
 * Incluye la transformación del Booleano de QB a string para HS
 */
function normalizeQbItemToHs(qbItem) {
  return {
    name: qbItem.Name || "",
    description: qbItem.Description || "",
    price: qbItem.UnitPrice ? String(qbItem.UnitPrice) : "0",
    hs_sku: qbItem.Sku || "",
    es_gravable: qbItem.Taxable ? "true" : "false",
    id_producto_quickbooks: qbItem.Id.toString()
  };
}

function generateHash(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * --- SINCRONIZACIÓN HS -> QB (Productos) ---
 */
async function processProduct(hsProductId, tenantId = DEFAULT_TENANT_ID) {
  // 🛡️ CAPA 2: SUPRESIÓN DE ECO
  if (echoSuppression.wasCreatedInHs(hsProductId)) {
    logger.info(`♻️ [Echo Check] Ignorando evento de Producto HS ID ${hsProductId} (generado internamente).`);
    return null;
  }

  logger.info(`[Sync] Procesando Producto HS ID: ${hsProductId}`, { source: 'HUBSPOT', entity: 'product', entityId: hsProductId, tenantId });

  const product = await hubspotClient.getProductDetails(hsProductId).catch(() => null);
  if (!product) {
    logger.warn(`⚠️ Producto HS ${hsProductId} no encontrado (Posiblemente borrado).`);
    return null;
  }

  const incomeAccountId = await getIncomeAccountId(tenantId);
  const normalizedData = normalizeHsProductToQb(product, incomeAccountId);
  const newHash = generateHash(normalizedData);
  
  const mapping = await mappingService.findByHsId(tenantId, 'product', hsProductId);
  let qbItemId = null;

  // CASO A: ACTUALIZACIÓN
  if (mapping && mapping.qbId) {
    qbItemId = mapping.qbId;
    if (mapping.payloadHash === newHash) {
      logger.info(`⏩ Producto sin cambios reales (Hash coincide). Omitiendo QB.`);
      return { qbItemId };
    }

    logger.info(`📝 Actualizando producto en QuickBooks...`);
    
    const currentQbData = await quickbooksClient.getItemById(qbItemId).catch(() => null);
    if (!currentQbData || currentQbData.Active === false) {
      logger.warn(`⚠️ Producto QB ${qbItemId} no encontrado o inactivo. Creando uno nuevo...`);
      const newItem = await quickbooksClient.createItem(normalizedData);
      echoSuppression.markAsCreatedInQb(newItem.Id);
      qbItemId = newItem.Id;
      await mappingService.upsertMapping({
        tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
        qbSyncToken: newItem.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
      });
      echoSuppression.markAsCreatedInHs(hsProductId);
      await hubspotClient.updateProduct(hsProductId, { id_producto_quickbooks: qbItemId }).catch(err => {
        logger.warn(`No se pudo actualizar el ID de QB en HubSpot para el producto ${hsProductId}: ${err.message}`);
      });
      return { qbItemId };
    }

    echoSuppression.markAsCreatedInQb(qbItemId);
    const updated = await quickbooksClient.updateItem(qbItemId, currentQbData.SyncToken, normalizedData);

    await mappingService.upsertMapping({
      tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
      qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
    });

  } else {
    // CASO B: CREACIÓN
    let existingQb = await quickbooksClient.findItemByName(normalizedData.Name).catch(() => null);
    
    if (!existingQb) {
      logger.info(`✨ Creando nuevo producto en QuickBooks...`);
      existingQb = await quickbooksClient.createItem(normalizedData);
      echoSuppression.markAsCreatedInQb(existingQb.Id);
    } else {
      logger.info(`🔗 Producto encontrado en QB por Nombre. Enlazando...`);
    }

    qbItemId = existingQb.Id;

    await mappingService.upsertMapping({
      tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
      qbSyncToken: existingQb.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
    });
    
    // 🛡️ FIX UX: Forzamos la actualización del ID de QB en HubSpot
    echoSuppression.markAsCreatedInHs(hsProductId);
    await hubspotClient.updateProduct(hsProductId, { id_producto_quickbooks: qbItemId }).catch(err => {
      logger.warn(`No se pudo actualizar el ID de QB en HubSpot para el producto ${hsProductId}: ${err.message}`);
    });
  }

  return { qbItemId };
}

/**
 * --- SINCRONIZACIÓN QB -> HS (Productos) ---
 */
async function syncItemFromQuickbooks(qbItemId, tenantId = DEFAULT_TENANT_ID) {
  // 🛡️ CAPA 2: SUPRESIÓN DE ECO
  if (echoSuppression.wasCreatedInQb(qbItemId)) {
    logger.info(`♻️ [Echo Check] Ignorando evento de Item QB ID ${qbItemId} (generado internamente).`);
    return null;
  }

  logger.info(`[Sync] Sincronizando Item QB ID: ${qbItemId} hacia HubSpot`, { source: 'QUICKBOOKS', entity: 'product', entityId: qbItemId, tenantId });

  const qbItem = await quickbooksClient.getItemById(qbItemId).catch(() => null);
  if (!qbItem) return null;

  if (qbItem.Type === 'Category') {
    logger.info(`⏩ Item QB ID ${qbItemId} es una Categoría. Omitiendo.`);
    return null;
  }

  const hsProps = normalizeQbItemToHs(qbItem);
  const newHash = generateHash(hsProps);
  
  const mapping = await mappingService.findByQbId(tenantId, 'product', qbItemId);
  let hsProductId = mapping ? mapping.hsId : null;

  // CASO A: ACTUALIZACIÓN
  if (hsProductId) {
    if (mapping.payloadHash === newHash) {
      logger.info(`⏩ Producto sin cambios reales (Hash coincide). Omitiendo actualización en HS.`);
    } else {
      logger.info(`✅ Producto HS encontrado. Actualizando...`);
      echoSuppression.markAsCreatedInHs(hsProductId);
      await hubspotClient.updateProduct(hsProductId, hsProps);
      
      await mappingService.upsertMapping({
        tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
        qbSyncToken: qbItem.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
      });
    }
  } else {
    // CASO B: CREACIÓN
    logger.info(`✨ Producto no mapeado. Creando en HS...`);
    // 🛡️ FIX: Llamada genérica con todas las propiedades incluyendo el ID
    const newProduct = await hubspotClient.createProduct(hsProps);
    hsProductId = newProduct.id;
    echoSuppression.markAsCreatedInHs(hsProductId);
    
    await mappingService.upsertMapping({
      tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
      qbSyncToken: qbItem.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
    });
  }
}

module.exports = { processProduct, syncItemFromQuickbooks };