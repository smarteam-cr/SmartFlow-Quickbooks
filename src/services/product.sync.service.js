// src/services/product.sync.service.js
const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

// Mapeos bidireccionales del tipo de producto
const QB_TYPE_TO_HS_PRODUCT_TYPE = {
  Service: 'service',
  NonInventory: 'non_inventory',
  Inventory: 'inventory',
};
const HS_PRODUCT_TYPE_TO_QB_TYPE = {
  service: 'Service',
  non_inventory: 'NonInventory',
  inventory: 'Inventory',
};
// Tipos de QB que NO se sincronizan a HS (no tienen equivalente en HS)
const QB_UNSYNCED_TYPES = new Set(['Category', 'Group', 'Bundle']);

/**
 * Campos que HS envía a QB.
 * Solo se incluye un campo si HS tiene valor → backward-compat para productos
 * existentes que aún no tienen cuenta_de_ingresos / impuesto_sobre_las_ventas.
 */
function buildHsControlledFields(hsProduct) {
  const props = hsProduct.properties || {};
  const payload = {
    Name: props.name || `Product-${hsProduct.id}`,
    Description: props.description || "",
    UnitPrice: props.hs_price_usd ? Number(props.hs_price_usd) : 0,
    Sku: props.hs_sku || "",
  };
  if (props.cuenta_de_ingresos) {
    payload.IncomeAccountRef = { value: props.cuenta_de_ingresos };
  }
  if (props.impuesto_sobre_las_ventas) {
    payload.SalesTaxCodeRef = { value: props.impuesto_sobre_las_ventas };
  }
  return payload;
}

/**
 * Normalización QB → HS (Items a Productos).
 */
function normalizeQbItemToHs(qbItem) {
  return {
    name: qbItem.Name || "",
    description: qbItem.Description || "",
    hs_price_usd: qbItem.UnitPrice ? String(qbItem.UnitPrice) : "0",
    hs_sku: qbItem.Sku || "",
    hs_product_type: QB_TYPE_TO_HS_PRODUCT_TYPE[qbItem.Type] || "",
    cuenta_de_ingresos: qbItem.IncomeAccountRef?.value || "",
    impuesto_sobre_las_ventas: qbItem.SalesTaxCodeRef?.value || "",
    id_producto_quickbooks: qbItem.Id.toString()
  };
}

function generateHash(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * --- SINCRONIZACIÓN HS → QB (Productos) ---
 * CASO A: existe mapping → actualización.
 * CASO B: no existe mapping → intenta creación si los campos requeridos están presentes.
 *
 * Campos requeridos para creación: name, hs_price_usd, cuenta_de_ingresos, hs_product_type
 * (service o non_inventory — inventory se rechaza).
 */
async function processProduct(hsProductId, tenantId = DEFAULT_TENANT_ID) {
  if (echoSuppression.wasCreatedInHs(hsProductId)) {
    logger.info(`♻️ [Echo Check] Ignorando evento de Producto HS ID ${hsProductId} (generado internamente).`);
    return null;
  }

  logger.info(`[Sync] Procesando Producto HS ID: ${hsProductId}`, { source: 'HUBSPOT', entity: 'product', entityId: hsProductId, tenantId });

  const product = await hubspotClient.getProductDetails(hsProductId).catch(() => null);
  if (!product) {
    logger.warn(`⚠️ Producto HS ${hsProductId} no encontrado (posiblemente borrado).`);
    return null;
  }

  const props = product.properties || {};
  const hsProductType = (props.hs_product_type || '').toLowerCase();

  // Regla de negocio: Inventory no se sincroniza desde HS (requiere campos de stock que HS no maneja).
  if (hsProductType === 'inventory') {
    logger.warn(`⚠️ Producto HS ${hsProductId} tiene hs_product_type=inventory. No se sincroniza HS→QB: los items Inventory deben gestionarse en QuickBooks.`);
    return null;
  }

  const hsControlledFields = buildHsControlledFields(product);
  const newHash = generateHash({ ...hsControlledFields, hs_product_type: hsProductType });
  const mapping = await mappingService.findByHsId(tenantId, 'product', hsProductId);

  // CASO A: ACTUALIZACIÓN
  if (mapping && mapping.qbId) {
    const qbItemId = mapping.qbId;
    if (mapping.payloadHash === newHash) {
      logger.info(`⏩ Producto sin cambios reales (Hash coincide). Omitiendo QB.`);
      return { qbItemId };
    }

    if (hsProductType === 'inventory') {
      logger.warn(`⚠️ Producto HS ${hsProductId} tiene hs_product_type=inventory. No se actualiza nada en QB — los items Inventory deben gestionarse directamente en QuickBooks.`);
      return { qbItemId };
    }

    logger.info(`📝 Actualizando producto en QuickBooks...`);

    const currentQbData = await quickbooksClient.getItemById(qbItemId).catch(() => null);
    if (!currentQbData || currentQbData.Active === false) {
      logger.warn(`⚠️ Producto QB ${qbItemId} no encontrado o inactivo. Se omite la actualización — debe recrearse desde QB.`);
      return { qbItemId };
    }

    // Type: solo cambiar si HS tiene un valor válido (service/non_inventory). Nunca a Inventory.
    // Si HS no tiene hs_product_type, preservar el Type actual de QB.
    const mappedType = HS_PRODUCT_TYPE_TO_QB_TYPE[hsProductType];
    const typeToSend = mappedType || currentQbData.Type;

    // IncomeAccountRef/SalesTaxCodeRef: si HS no trae valor, preservar el de QB (backward-compat).
    const updatePayload = {
      ...hsControlledFields,
      Type: typeToSend,
    };
    if (!updatePayload.IncomeAccountRef) {
      updatePayload.IncomeAccountRef = currentQbData.IncomeAccountRef;
    }
    if (!updatePayload.SalesTaxCodeRef && currentQbData.SalesTaxCodeRef) {
      updatePayload.SalesTaxCodeRef = currentQbData.SalesTaxCodeRef;
    }

    echoSuppression.markAsCreatedInQb(qbItemId);
    const updated = await quickbooksClient.updateItem(qbItemId, currentQbData.SyncToken, updatePayload);

    await mappingService.upsertMapping({
      tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
      qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
    });

    return { qbItemId };
  }

  // CASO B: CREACIÓN en QB
  const missing = [];
  if (!props.name) missing.push('name');
  if (!props.hs_price_usd) missing.push('hs_price_usd');
  if (!props.cuenta_de_ingresos) missing.push('cuenta_de_ingresos');
  if (!hsProductType) missing.push('hs_product_type');
  if (missing.length > 0) {
    logger.warn(`⚠️ Producto HS ${hsProductId} no se puede crear en QB: faltan campos requeridos [${missing.join(', ')}].`);
    return null;
  }

  const qbType = HS_PRODUCT_TYPE_TO_QB_TYPE[hsProductType];
  if (!qbType) {
    logger.warn(`⚠️ Producto HS ${hsProductId}: hs_product_type="${hsProductType}" no es válido para sync a QB.`);
    return null;
  }

  // Reutilizar item QB existente si coincide el nombre (evita duplicados).
  let qbItem = await quickbooksClient.findItemByName(props.name).catch(() => null);
  if (qbItem) {
    logger.info(`🔗 Producto "${props.name}" ya existe en QB (ID ${qbItem.Id}). Enlazando sin crear duplicado.`);
  } else {
    logger.info(`✨ Creando producto "${props.name}" en QuickBooks...`);
    const createPayload = {
      Name: props.name,
      Type: qbType,
      UnitPrice: Number(props.hs_price_usd),
      Description: props.description || "",
      Sku: props.hs_sku || "",
      IncomeAccountRef: { value: props.cuenta_de_ingresos },
    };
    if (props.impuesto_sobre_las_ventas) {
      createPayload.SalesTaxCodeRef = { value: props.impuesto_sobre_las_ventas };
    }
    qbItem = await quickbooksClient.createItem(createPayload);
    echoSuppression.markAsCreatedInQb(qbItem.Id);
  }

  const qbItemId = qbItem.Id;
  await mappingService.upsertMapping({
    tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
    qbSyncToken: qbItem.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
  });

  // Feedback a HS: grabar el ID de QB en el producto de HS
  echoSuppression.markAsCreatedInHs(hsProductId);
  await hubspotClient.updateProductProperty(hsProductId, qbItemId).catch(err => {
    logger.warn(`No se pudo escribir id_producto_quickbooks en HS ${hsProductId}: ${err.message}`);
  });

  return { qbItemId };
}

/**
 * --- SINCRONIZACIÓN QB → HS (Productos) ---
 */
async function syncItemFromQuickbooks(qbItemId, tenantId = DEFAULT_TENANT_ID) {
  if (echoSuppression.wasCreatedInQb(qbItemId)) {
    logger.info(`♻️ [Echo Check] Ignorando evento de Item QB ID ${qbItemId} (generado internamente).`);
    return null;
  }

  logger.info(`[Sync] Sincronizando Item QB ID: ${qbItemId} hacia HubSpot`, { source: 'QUICKBOOKS', entity: 'product', entityId: qbItemId, tenantId });

  const qbItem = await quickbooksClient.getItemById(qbItemId).catch(() => null);
  if (!qbItem) return null;

  if (QB_UNSYNCED_TYPES.has(qbItem.Type)) {
    logger.info(`⏩ Item QB ID ${qbItemId} tipo ${qbItem.Type}. Omitiendo sync a HS.`);
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
      return;
    }
    logger.info(`✅ Producto HS encontrado. Actualizando...`);
    echoSuppression.markAsCreatedInHs(hsProductId);
    await hubspotClient.updateProduct(hsProductId, hsProps);

    await mappingService.upsertMapping({
      tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
      qbSyncToken: qbItem.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
    });
    return;
  }

  // CASO B: CREACIÓN en HS
  logger.info(`✨ Producto no mapeado. Creando en HS...`);
  const newProduct = await hubspotClient.createProduct(hsProps);
  hsProductId = newProduct.id;
  echoSuppression.markAsCreatedInHs(hsProductId);

  await mappingService.upsertMapping({
    tenantId, entityType: 'product', hsId: hsProductId, qbId: qbItemId,
    qbSyncToken: qbItem.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
  });
}

module.exports = { processProduct, syncItemFromQuickbooks };
