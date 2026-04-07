const config = require('../config');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const echoSuppression = require('../utils/echo.suppression.util');
const mutex = require('../utils/mutex.util');
const logger = require('../lib/logger.lib');

/**
 * --- SINCRONIZACIÓN HS -> QB ---
 * Procesa la creación o actualización de un producto desde HubSpot.
 */
async function _internalSyncProductToQuickbooks(hsProductId) {
    logger.info(`[Sync] Procesando Producto HS ID: ${hsProductId}`, { source: 'HUBSPOT', entity: 'product', entityId: hsProductId });

    // 1. Supresión de Eco
    if (echoSuppression.wasCreatedInHs(hsProductId)) {
        logger.info(`♻️ [Echo] Ignorando producto ${hsProductId} (cambio interno).`);
        return;
    }

    try {
        // 2. Obtener datos de HubSpot
        const hsProduct = await hubspotClient.getProductDetails(hsProductId);
        if (!hsProduct) {
            logger.warn(`❌ Producto ${hsProductId} no encontrado en HubSpot.`);
            return;
        }

        const {
            name,
            description,
            hs_sku,
            price,
            hs_price_usd,
            es_gravable,
            id_producto_quickbooks
        } = hsProduct.properties;

        // Priorizamos hs_price_usd sobre price si existe
        const finalPrice = hs_price_usd ? Number(hs_price_usd) : (price ? Number(price) : 0);
        const isTaxable = es_gravable === "true" || es_gravable === true;

        // 3. Mapeo para QuickBooks
        const itemData = {
            Name: name,
            Description: description || "",
            UnitPrice: finalPrice,
            Sku: hs_sku || "",
            Taxable: isTaxable,
            Active: true,
            Type: "Service", // O "Inventory" según configuración, por defecto "Service"
            IncomeAccountRef: {
                value: config.quickbooks.incomeAccountId.toString()
            }
        };

        // 4. Resolución de Idempotencia y Existencia
        let qbItemId = null;
        let existingItem = null;

        if (id_producto_quickbooks) {
            existingItem = await quickbooksClient.getItemById(id_producto_quickbooks).catch(() => null);
        }

        if (!existingItem && name) {
            logger.info(`🔍 Buscando producto en QB por nombre: "${name}"...`);
            existingItem = await quickbooksClient.findItemByName(name);
        }

        // 5. Lógica de Sincronización
        if (existingItem) {
            qbItemId = existingItem.Id;
            const qbSyncToken = existingItem.SyncToken;

            logger.info(`🔄 Producto ENCONTRADO (QB ID: ${qbItemId}). Validando cambios reales...`);

            // --- DEEP COMPARE ---
            const hasRealChanges = 
                (itemData.Name !== (existingItem.Name || "")) ||
                (itemData.Description !== (existingItem.Description || "")) ||
                (Math.abs(itemData.UnitPrice - (existingItem.UnitPrice || 0)) > 0.01) ||
                (itemData.Sku !== (existingItem.Sku || "")) ||
                (itemData.Taxable !== (existingItem.Taxable || false));

            if (!hasRealChanges) {
                logger.info(`⏩ Sin cambios reales. Omitiendo actualización en QuickBooks (ECO).`);
            } else {
                logger.info(`📝 Cambios detectados. Actualizando producto en QuickBooks...`);
                echoSuppression.markAsCreatedInQb(qbItemId);
                await quickbooksClient.updateItem(qbItemId, qbSyncToken, itemData);
            }
        } else {
            // === CREACIÓN ===
            logger.info(`✨ Creando nuevo producto en QuickBooks: "${name}"...`);
            const newQbItem = await quickbooksClient.createItem(itemData);
            qbItemId = newQbItem.Id;
            echoSuppression.markAsCreatedInQb(qbItemId);
            logger.info(`✅ Producto creado en QB con ID: ${qbItemId}`);
        }

        // 6. Vincular el ID en HubSpot si es necesario
        if (qbItemId && (!id_producto_quickbooks || id_producto_quickbooks !== qbItemId.toString())) {
            logger.info(`🔗 Enlazando ID de QuickBooks ${qbItemId} en HubSpot...`);
            echoSuppression.markAsCreatedInHs(hsProductId);
            await hubspotClient.updateProductProperty(hsProductId, qbItemId);
        }
    } catch (error) {
        logger.error(`❌ Error sincronizando producto HS ${hsProductId} a QuickBooks:`, error);
        throw error;
    }
}

/**
 * --- SINCRONIZACIÓN QB -> HS ---
 * Procesa la creación o actualización de un producto desde QuickBooks.
 */
async function _internalSyncProductFromQuickbooks(qbItemId) {
    logger.info(`[Sync] Sincronizando Item QB ID: ${qbItemId} hacia HubSpot`, { source: 'QUICKBOOKS', entity: 'product', entityId: qbItemId });

    // 1. Supresión de Eco
    if (echoSuppression.wasCreatedInQb(qbItemId)) {
        logger.info(`♻️ [Echo] Ignorando item ${qbItemId} (cambio interno).`);
        return;
    }

    try {
        // 2. Obtener datos de QuickBooks
        const qbItem = await quickbooksClient.getItemById(qbItemId);
        if (!qbItem) {
            logger.error(`❌ No se encontró el Item ${qbItemId} en QuickBooks.`);
            return;
        }

        // 3. Buscar en HubSpot
        let hsProduct = await hubspotClient.searchProductByQbId(qbItemId);

        const properties = {
            name: qbItem.Name,
            price: (qbItem.UnitPrice || 0).toString(),
            description: qbItem.Description || "",
            hs_sku: qbItem.Sku || "",
            es_gravable: qbItem.Taxable ? "true" : "false",
            id_producto_quickbooks: qbItemId.toString()
        };

        if (hsProduct) {
            logger.info(`🔄 Producto HS encontrado (ID: ${hsProduct.id}). Validando cambios reales...`);

            // --- DEEP COMPARE ---
            const hasRealChanges = 
                (properties.name !== (hsProduct.properties.name || "")) ||
                (Math.abs(Number(properties.price) - Number(hsProduct.properties.price || 0)) > 0.01) ||
                (properties.description !== (hsProduct.properties.description || "")) ||
                (properties.hs_sku !== (hsProduct.properties.hs_sku || "")) ||
                (properties.es_gravable !== (hsProduct.properties.es_gravable || "false"));

            if (!hasRealChanges) {
                logger.info(`⏩ Sin cambios reales. Omitiendo actualización en HubSpot (ECO).`);
            } else {
                logger.info(`📝 Cambios detectados. Actualizando producto en HubSpot...`);
                echoSuppression.markAsCreatedInHs(hsProduct.id);
                await hubspotClient.updateProduct(hsProduct.id, properties);
            }
        } else {
            // === CREACIÓN ===
            logger.info(`✨ Producto no existe en HubSpot. Creando...`);
            const newHsProduct = await hubspotClient.createProduct({
                ...properties,
                isTaxable: qbItem.Taxable,
                qbId: qbItemId
            });
            echoSuppression.markAsCreatedInHs(newHsProduct.id);
            logger.info(`✅ Producto creado en HS (ID: ${newHsProduct.id})`);
        }
    } catch (error) {
        logger.error(`❌ Error sincronizando Item QB ${qbItemId} hacia HubSpot:`, error);
        throw error;
    }
}

/**
 * Wrappers con Mutex
 */
async function syncProductToQuickbooks(hsProductId) {
    return await _internalSyncProductToQuickbooks(hsProductId);
}

async function syncProductFromQuickbooks(qbItemId) {
    return await _internalSyncProductFromQuickbooks(qbItemId);
}

module.exports = {
    syncProductToQuickbooks,
    syncProductFromQuickbooks
};