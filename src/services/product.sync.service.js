const config = require('../config');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');

/**
 * Sincroniza un producto recién creado desde HubSpot hacia QuickBooks.
 * Implementa idempotencia y previene errores por nombres duplicados.
 * * @param {string|number} hsProductId - El ID del producto que origina el webhook en HubSpot.
 */
async function syncProductToQuickbooks(hsProductId) {
  try {
    const hsProduct = await hubspotClient.getProductDetails(hsProductId);

    if (!hsProduct) {
      console.warn(`Producto ${hsProductId} no encontrado en HubSpot. Sincronización abortada.`);
      return null;
    }

    // 1. Verificación de idempotencia
    // Si el producto ya tiene un ID de QuickBooks asignado, se detiene el flujo para evitar duplicados.
    if (hsProduct.properties.id_producto_quickbooks) {
      console.log(`El producto ${hsProductId} ya posee un ID de QuickBooks (${hsProduct.properties.id_producto_quickbooks}). Omitiendo creación.`);
      return hsProduct.properties.id_producto_quickbooks;
    }

    const productName = hsProduct.properties.name;
    let qbItemId;

    // 2. Validación de restricción de nombre único en QuickBooks
    // La API de Intuit devuelve error 400 si se intenta crear un Item con un nombre existente.
    const existingQbItem = await quickbooksClient.findItemByName(productName);

    if (existingQbItem) {
      console.log(`El producto "${productName}" ya existe en QuickBooks con ID ${existingQbItem.Id}. Se procederá a vincularlos.`);
      qbItemId = existingQbItem.Id;
    } else {
      // 3. Mapeo de datos y creación del Item en QuickBooks
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
      console.log(`Producto "${productName}" creado en QuickBooks con ID: ${qbItemId}`);
    }

    // 4. Actualización del registro en HubSpot (El Ancla)
    await hubspotClient.updateProductProperty(hsProductId, qbItemId);
    console.log(`Propiedad id_producto_quickbooks actualizada en HubSpot para el producto ${hsProductId}.`);

    return qbItemId;

  } catch (error) {
    console.error(`Error en la sincronización del producto ${hsProductId} hacia QuickBooks:`, error.message);
    throw error;
  }
}

/**
 * Sincroniza la creación de un Item desde QuickBooks hacia HubSpot.
 * Descarga los detalles de QB y verifica idempotencia en HS antes de crear.
 */
async function syncProductFromQuickbooks(qbItemId) {
  try {
    // 1. Verificar idempotencia para evitar bucles infinitos
    const existingHsProduct = await hubspotClient.searchProductByQbId(qbItemId);
    
    if (existingHsProduct) {
      console.log(`El Item de QB (${qbItemId}) ya existe en HubSpot (ID: ${existingHsProduct.id}). Ignorando webhook para evitar bucle.`);
      return existingHsProduct.id;
    }

    // 2. Descargar los detalles completos desde QuickBooks
    const qbItem = await quickbooksClient.getItemById(qbItemId);

    if (!qbItem) {
      console.warn(`Item ${qbItemId} no encontrado en QuickBooks.`);
      return null;
    }

    // 3. Mapear datos y crear el producto en HubSpot
    const hsProductPayload = {
      name: qbItem.Name,
      price: qbItem.UnitPrice ? qbItem.UnitPrice : 0,
      description: qbItem.Description || "",
      qbId: qbItemId
    };

    const newHsProduct = await hubspotClient.createProduct(hsProductPayload);
    console.log(`✅ Producto creado en HubSpot (ID: ${newHsProduct.id}) a partir del Item de QuickBooks (${qbItemId}).`);
    
    return newHsProduct.id;

  } catch (error) {
    console.error(`Error en la sincronización del Item ${qbItemId} hacia HubSpot:`, error.message);
    throw error;
  }
}

module.exports = {
  syncProductToQuickbooks,
  syncProductFromQuickbooks
};