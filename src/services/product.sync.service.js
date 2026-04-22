// src/services/product.sync.service.js
const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

// Solo los campos que HS tiene autoridad para modificar en QB.
// Campos contables (IncomeAccountRef, Type, Sku) son propiedad de QB y nunca se pisan desde HS.
function buildHsControlledFields(hsProduct) {
  const props = hsProduct.properties || {};
  return {
    Name: props.name || `Product-${hsProduct.id}`,
    Description: props.description || "",
    UnitPrice: props.price ? Number(props.price) : 0,
    Taxable: props.es_gravable === 'true' || props.es_gravable === true,
  };
}

// QB Type → HS hs_product_type. Group/Bundle no tienen equivalente en HS → "".
const QB_TYPE_TO_HS_PRODUCT_TYPE = {
  Service: 'service',
  NonInventory: 'non_inventory',
  Inventory: 'inventory',
};

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
    hs_product_type: QB_TYPE_TO_HS_PRODUCT_TYPE[qbItem.Type] || "",
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

  const hsControlledFields = buildHsControlledFields(product);
  const newHash = generateHash(hsControlledFields);

  const mapping = await mappingService.findByHsId(tenantId, 'product', hsProductId);
  let qbItemId = null;

  // CASO A: ACTUALIZACIÓN — el producto ya existe en QB, solo actualizamos campos permitidos desde HS
  if (mapping && mapping.qbId) {
    qbItemId = mapping.qbId;
    if (mapping.payloadHash === newHash) {
      logger.info(`⏩ Producto sin cambios reales (Hash coincide). Omitiendo QB.`);
      return { qbItemId };
    }

    logger.info(`📝 Actualizando producto en QuickBooks...`);

    const currentQbData = await quickbooksClient.getItemById(qbItemId).catch(() => null);
    if (!currentQbData || currentQbData.Active === false) {
      logger.warn(`⚠️ Producto QB ${qbItemId} no encontrado o inactivo. Se omite la actualización — debe recrearse desde QB.`);
      return { qbItemId };
    }

    // Preservar todos los campos contables/estructurales que pertenecen a QB
    const updatePayload = {
      ...hsControlledFields,
      IncomeAccountRef: currentQbData.IncomeAccountRef,
      Type: currentQbData.Type,
      Sku: currentQbData.Sku || "",
    };

    echoSuppression.markAsCreatedInQb(qbItemId);
    const updated = await quickbooksClient.updateItem(qbItemId, currentQbData.SyncToken, updatePayload);

    await mappingService.upsertMapping({
      tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
      qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
    });

  } else {
    // CASO B: No hay mapping — los productos deben originarse en QB, no en HS
    logger.warn(`⚠️ Producto HS ${hsProductId} no tiene mapping con QB. Los productos deben crearse desde QuickBooks.`);
    return null;
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