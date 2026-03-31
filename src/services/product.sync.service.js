const config = require('../config');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const echoSuppression = require('../utils/echo.suppression.util');

/**
 * Sincroniza un producto recién creado desde HubSpot hacia QuickBooks.
 * @param {string|number} hsProductId - ID del producto desde el webhook de HubSpot.
 */
async function syncProductToQuickbooks(hsProductId) {
  try {
    // 1. Supresión de Eco: Verifica si este webhook fue provocado por el propio sistema
    if (echoSuppression.wasCreatedInHs(hsProductId)) {
      console.log(`[Echo Suppression] Producto HS ${hsProductId} fue creado por el sistema. Ignorando webhook.`);
      return hsProductId;
    }

    const hsProduct = await hubspotClient.getProductDetails(hsProductId);

    if (!hsProduct) {
      console.warn(`Producto ${hsProductId} no encontrado en HubSpot.`);
      return null;
    }

    // 2. Validación de Idempotencia en base de datos
    if (hsProduct.properties.id_producto_quickbooks) {
      console.log(`Producto ${hsProductId} ya posee ID de QuickBooks (${hsProduct.properties.id_producto_quickbooks}).`);
      return hsProduct.properties.id_producto_quickbooks;
    }

    const productName = hsProduct.properties.name;
    let qbItemId;

    const existingQbItem = await quickbooksClient.findItemByName(productName);

    if (existingQbItem) {
      console.log(`Producto "${productName}" ya existe en QuickBooks (ID ${existingQbItem.Id}). Vinculando.`);
      qbItemId = existingQbItem.Id;
    } else {
      const qbItemPayload = {
        Name: productName,
        Description: hsProduct.properties.description || "",
        Active: true,
        Type: "Service",
        UnitPrice: hsProduct.properties.price ? Number(hsProduct.properties.price) : 0,
        IncomeAccountRef: {
          value: config.quickbooks.incomeAccountId.toString()
        }
      };

      if (hsProduct.properties.hs_sku) {
        qbItemPayload.Sku = hsProduct.properties.hs_sku;
      }

      const newQbItem = await quickbooksClient.createItem(qbItemPayload);
      qbItemId = newQbItem.Id;
      
      // 3. Registro en caché: Marca el ID generado en QB para ignorar su posterior webhook
      echoSuppression.markAsCreatedInQb(qbItemId);
      
      console.log(`Producto "${productName}" creado en QuickBooks con ID: ${qbItemId}`);
    }

    // 4. Actualización del ancla
    await hubspotClient.updateProductProperty(hsProductId, qbItemId);
    console.log(`Propiedad id_producto_quickbooks actualizada en HubSpot para el producto ${hsProductId}.`);

    return qbItemId;

  } catch (error) {
    console.error(`Error sincronizando producto ${hsProductId} hacia QuickBooks:`, error.message);
    throw error;
  }
}

/**
 * Sincroniza un Item recién creado desde QuickBooks hacia HubSpot.
 * @param {string|number} qbItemId - ID del Item desde el webhook de QuickBooks.
 */
async function syncProductFromQuickbooks(qbItemId) {
  try {
    // 1. Supresión de Eco: Verifica si este webhook fue provocado por el propio sistema
    if (echoSuppression.wasCreatedInQb(qbItemId)) {
      console.log(`[Echo Suppression] Item QB ${qbItemId} fue creado por el sistema. Ignorando webhook.`);
      return qbItemId;
    }

    // 2. Validación de Idempotencia en base de datos
    const existingHsProduct = await hubspotClient.searchProductByQbId(qbItemId);
    
    if (existingHsProduct) {
      console.log(`Item QB ${qbItemId} ya existe en HubSpot (ID: ${existingHsProduct.id}). Ignorando.`);
      return existingHsProduct.id;
    }

    const qbItem = await quickbooksClient.getItemById(qbItemId);

    if (!qbItem) {
      console.warn(`Item ${qbItemId} no encontrado en QuickBooks.`);
      return null;
    }

    const hsProductPayload = {
      name: qbItem.Name,
      price: qbItem.UnitPrice ? qbItem.UnitPrice : 0,
      description: qbItem.Description || "",
      hs_sku: qbItem.Sku || "",
      qbId: qbItemId,
      isTaxable: qbItem.Taxable,
    };

    const newHsProduct = await hubspotClient.createProduct(hsProductPayload);
    
    // 3. Registro en caché: Marca el ID generado en HS para ignorar su posterior webhook
    echoSuppression.markAsCreatedInHs(newHsProduct.id);
    
    console.log(`Producto creado en HubSpot (ID: ${newHsProduct.id}) a partir del Item QB (${qbItemId}).`);
    
    return newHsProduct.id;

  } catch (error) {
    console.error(`Error sincronizando Item ${qbItemId} hacia HubSpot:`, error.message);
    throw error;
  }
}

module.exports = {
  syncProductToQuickbooks,
  syncProductFromQuickbooks
};