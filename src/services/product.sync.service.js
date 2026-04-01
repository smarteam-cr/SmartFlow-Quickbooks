const config = require('../config');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const echoSuppression = require('../utils/echo.suppression.util');
const mutex = require('../utils/mutex.util');

/**
 * --- SINCRONIZACIÓN HS -> QB ---
 * Procesa la creación o actualización de un producto desde HubSpot.
 */
async function _internalSyncProductToQuickbooks(hsProductId) {
    console.log(`\n--- 📦 Procesando Producto HS ID: ${hsProductId} ---`);

    // 1. Supresión de Eco
    if (echoSuppression.wasCreatedInHs(hsProductId)) {
        console.log(`♻️ [Echo] Ignorando producto ${hsProductId} (cambio interno).`);
        return;
    }

    // 2. Obtener datos de HubSpot
    const hsProduct = await hubspotClient.getProductDetails(hsProductId);
    if (!hsProduct) {
        console.warn(`❌ Producto ${hsProductId} no encontrado en HubSpot.`);
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
        console.log(`🔍 Buscando producto en QB por nombre: "${name}"...`);
        existingItem = await quickbooksClient.findItemByName(name);
    }

    // 5. Lógica de Sincronización
    if (existingItem) {
        qbItemId = existingItem.Id;
        const qbSyncToken = existingItem.SyncToken;

        console.log(`🔄 Producto ENCONTRADO (QB ID: ${qbItemId}). Validando cambios reales...`);

        // --- DEEP COMPARE ---
        const hasRealChanges = 
            (itemData.Name !== (existingItem.Name || "")) ||
            (itemData.Description !== (existingItem.Description || "")) ||
            (Math.abs(itemData.UnitPrice - (existingItem.UnitPrice || 0)) > 0.01) ||
            (itemData.Sku !== (existingItem.Sku || "")) ||
            (itemData.Taxable !== (existingItem.Taxable || false));

        if (!hasRealChanges) {
            console.log(`⏩ Sin cambios reales. Omitiendo actualización en QuickBooks (ECO).`);
        } else {
            console.log(`📝 Cambios detectados. Actualizando producto en QuickBooks...`);
            echoSuppression.markAsCreatedInQb(qbItemId);
            await quickbooksClient.updateItem(qbItemId, qbSyncToken, itemData);
        }
    } else {
        // === CREACIÓN ===
        console.log(`✨ Creando nuevo producto en QuickBooks: "${name}"...`);
        const newQbItem = await quickbooksClient.createItem(itemData);
        qbItemId = newQbItem.Id;
        echoSuppression.markAsCreatedInQb(qbItemId);
        console.log(`✅ Producto creado en QB con ID: ${qbItemId}`);
    }

    // 6. Vincular el ID en HubSpot si es necesario
    if (qbItemId && (!id_producto_quickbooks || id_producto_quickbooks !== qbItemId.toString())) {
        console.log(`🔗 Enlazando ID de QuickBooks ${qbItemId} en HubSpot...`);
        echoSuppression.markAsCreatedInHs(hsProductId);
        await hubspotClient.updateProductProperty(hsProductId, qbItemId);
    }
}

/**
 * --- SINCRONIZACIÓN QB -> HS ---
 * Procesa la creación o actualización de un producto desde QuickBooks.
 */
async function _internalSyncProductFromQuickbooks(qbItemId) {
    console.log(`\n--- 🟢 Sincronizando Item QB ID: ${qbItemId} hacia HubSpot ---`);

    // 1. Supresión de Eco
    if (echoSuppression.wasCreatedInQb(qbItemId)) {
        console.log(`♻️ [Echo] Ignorando item ${qbItemId} (cambio interno).`);
        return;
    }

    // 2. Obtener datos de QuickBooks
    const qbItem = await quickbooksClient.getItemById(qbItemId);
    if (!qbItem) {
        console.error(`❌ No se encontró el Item ${qbItemId} en QuickBooks.`);
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
        console.log(`🔄 Producto HS encontrado (ID: ${hsProduct.id}). Validando cambios reales...`);

        // --- DEEP COMPARE ---
        const hasRealChanges = 
            (properties.name !== (hsProduct.properties.name || "")) ||
            (Math.abs(Number(properties.price) - Number(hsProduct.properties.price || 0)) > 0.01) ||
            (properties.description !== (hsProduct.properties.description || "")) ||
            (properties.hs_sku !== (hsProduct.properties.hs_sku || "")) ||
            (properties.es_gravable !== (hsProduct.properties.es_gravable || "false"));

        if (!hasRealChanges) {
            console.log(`⏩ Sin cambios reales. Omitiendo actualización en HubSpot (ECO).`);
        } else {
            console.log(`📝 Cambios detectados. Actualizando producto en HubSpot...`);
            echoSuppression.markAsCreatedInHs(hsProduct.id);
            await hubspotClient.updateProduct(hsProduct.id, properties);
        }
    } else {
        // === CREACIÓN ===
        console.log(`✨ Producto no existe en HubSpot. Creando...`);
        const newHsProduct = await hubspotClient.createProduct({
            ...properties,
            isTaxable: qbItem.Taxable,
            qbId: qbItemId
        });
        echoSuppression.markAsCreatedInHs(newHsProduct.id);
        console.log(`✅ Producto creado en HS (ID: ${newHsProduct.id})`);
    }
}

/**
 * Wrappers con Mutex
 */
async function syncProductToQuickbooks(hsProductId) {
    return mutex.runSequentially(`HS_PROD_${hsProductId}`, async () => {
        return await _internalSyncProductToQuickbooks(hsProductId);
    });
}

async function syncProductFromQuickbooks(qbItemId) {
    return mutex.runSequentially(`QB_PROD_${qbItemId}`, async () => {
        return await _internalSyncProductFromQuickbooks(qbItemId);
    });
}

module.exports = {
    syncProductToQuickbooks,
    syncProductFromQuickbooks
};