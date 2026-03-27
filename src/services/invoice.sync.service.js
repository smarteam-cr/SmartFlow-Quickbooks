const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service'); // Reutilizamos tu lógica de contactos
const productSyncService = require('./product.sync.service'); // Reutilizamos tu lógica de productos

/**
 * Orquesta la creación de una factura desde HubSpot hacia QuickBooks.
 * Garantiza la existencia del Cliente y los Productos antes de facturar.
 * @param {string} invoiceId - El ID de la factura de HubSpot.
 */
async function syncInvoiceToQuickbooks(invoiceId) {
  try {
    console.log(`\n=== 🚀 INICIANDO SINCRONIZACIÓN DE FACTURA: ${invoiceId} ===`);

    // 1. Obtener la factura y validar idempotencia
    const hsInvoice = await hubspotClient.getInvoiceDetails(invoiceId);
    if (!hsInvoice) throw new Error(`La factura ${invoiceId} no existe en HubSpot.`);

    if (hsInvoice.properties.id_factura_quickbooks) {
      console.log(`✅ La factura ${invoiceId} ya existe en QuickBooks (ID: ${hsInvoice.properties.id_factura_quickbooks}). Omitiendo.`);
      return hsInvoice.properties.id_factura_quickbooks;
    }

    // 2. Obtener y validar el Contacto Asociado (Regla de negocio: Obligatorio)
    const contactAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'contacts');
    if (contactAssociations.length === 0) {
      throw new Error(`La factura ${invoiceId} no tiene un Contacto asociado en HubSpot. QuickBooks exige un Customer.`);
    }
    
    const contactId = contactAssociations[0];
    console.log(`👤 Procesando Contacto Asociado (ID: ${contactId})...`);
    
    // Invocamos tu servicio existente. Si no existe en QB, lo crea y devuelve el ID. Si existe, solo devuelve el ID.
    const qbCustomerId = await contactSyncService.processContact(contactId);
    if (!qbCustomerId) throw new Error(`No se pudo resolver el ID de QuickBooks para el contacto ${contactId}`);

    // 3. Obtener y validar los Productos (Line Items)
    const lineItemAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'line_items');
    if (lineItemAssociations.length === 0) {
      throw new Error(`La factura ${invoiceId} no tiene productos (Line Items) asociados.`);
    }

    console.log(`📦 Procesando ${lineItemAssociations.length} Productos (Line Items)...`);
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
    
    // Arreglo donde guardaremos las líneas de la factura para QuickBooks
    const qbInvoiceLines = [];

    for (const item of lineItemsData) {
      let qbItemId = item.properties.id_producto_quickbooks;
      
      // Si el producto no tiene ID de QB, lo sincronizamos "al vuelo"
      if (!qbItemId) {
        console.log(`   ⚠️ El producto "${item.properties.name}" no está en QuickBooks. Creándolo al vuelo...`);
        // Ojo: Para usar el syncProductToQuickbooks necesitamos el ID del Producto base, no del Line Item.
        // Pero como atajo de PoC, si no tenemos el ID del producto base, lo buscamos por nombre en QB
        const existingQbItem = await quickbooksClient.findItemByName(item.properties.name);
        if (existingQbItem) {
          qbItemId = existingQbItem.Id;
        } else {
          // Lo creamos directamente
          const newItem = await quickbooksClient.createItem({
            Name: item.properties.name,
            Type: "Service",
            UnitPrice: item.properties.price ? Number(item.properties.price) : 0,
            IncomeAccountRef: { value: require('../config').quickbooks.incomeAccountId.toString() }
          });
          qbItemId = newItem.Id;
        }
      }

      const price = Number(item.properties.price || 0);
      const qty = Number(item.properties.quantity || 1);

      // Estructura estricta de una línea de factura en QuickBooks
      qbInvoiceLines.push({
        Amount: price * qty,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: qbItemId.toString() },
          UnitPrice: price,
          Qty: qty
        }
      });
    }

    // 4. Armar el Payload Final de la Factura
    const qbInvoicePayload = {
      CustomerRef: {
        value: qbCustomerId.toString()
      },
      Line: qbInvoiceLines,
      // Opcional: Podemos poner el nombre de la factura de HubSpot como nota
      CustomerMemo: {
        value: hsInvoice.properties.hs_title || `Factura exportada desde HubSpot (${invoiceId})`
      }
    };

    console.log(`📝 Enviando Factura a QuickBooks por un total de $${hsInvoice.properties.hs_invoice_total || 'N/A'}...`);
    
    // 5. Crear la factura en QuickBooks
    const newQbInvoice = await quickbooksClient.createInvoice(qbInvoicePayload);
    
    // 6. Guardar el ancla en HubSpot
    await hubspotClient.updateInvoiceProperty(invoiceId, newQbInvoice.Id);
    
    console.log(`🎉 ¡ÉXITO! Factura sincronizada. ID en QuickBooks: ${newQbInvoice.Id}`);
    console.log(`=========================================================\n`);

    return newQbInvoice.Id;

  } catch (error) {
    console.error(`❌ Error en la sincronización de la factura ${invoiceId}:`, error.message);
    throw error;
  }
}

module.exports = {
  syncInvoiceToQuickbooks
};