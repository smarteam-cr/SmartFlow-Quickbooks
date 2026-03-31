const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service');
const qbMapper = require('../integrations/quickbooks/quickbooks.mapper');

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
    
    // Invocamos tu servicio existente.
    const qbCustomerId = await contactSyncService.processContact(contactId);
    if (!qbCustomerId) throw new Error(`No se pudo resolver el ID de QuickBooks para el contacto ${contactId}`);

    // 3. Obtener y validar los Productos (Line Items)
    const lineItemAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'line_items');
    if (lineItemAssociations.length === 0) {
      throw new Error(`La factura ${invoiceId} no tiene productos (Line Items) asociados.`);
    }

    console.log(`📦 Procesando ${lineItemAssociations.length} Productos (Line Items)...`);
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
    
    const qbInvoiceLines = [];
    let facturaLlevaImpuestos = false; 

    for (const item of lineItemsData) {
      let qbItemId = item.properties.id_producto_quickbooks;
      
      // Si el producto no tiene ID de QB, lo sincronizamos "al vuelo"
      if (!qbItemId) {
        console.log(`   ⚠️ El producto "${item.properties.name}" no está en QuickBooks. Creándolo al vuelo...`);
        const existingQbItem = await quickbooksClient.findItemByName(item.properties.name);
        if (existingQbItem) {
          qbItemId = existingQbItem.Id;
        } else {
          const newItem = await quickbooksClient.createItem({
            Name: item.properties.name,
            Type: "Service",
            UnitPrice: item.properties.price ? Number(item.properties.price) : 0,
            IncomeAccountRef: { value: require('../config').quickbooks.incomeAccountId.toString() }
          });
          qbItemId = newItem.Id;
        }
      }

      // Detectamos si la línea requiere impuestos
      if (item.properties.es_gravable === "true") {
        facturaLlevaImpuestos = true;
      }

      // 🌟 USAMOS EL MAPPER PARA TRADUCIR LA LÍNEA
      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId);
      qbInvoiceLines.push(mappedLine);
    }

    // 🌟 USAMOS EL MAPPER PARA ARMAR EL PAYLOAD FINAL DE LA FACTURA
    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines);

    // Lógica para inyectar la regla global de impuestos si es necesario
    if (facturaLlevaImpuestos) {
      // ⚠️ AQUÍ INYECTAREMOS EL ID DEL IMPUESTO MÁS ADELANTE
      console.log('Se detectaron productos gravables. (Pendiente inyectar TxnTaxDetail)');
    }

    console.log(`📝 Enviando Factura a QuickBooks por un total de $${hsInvoice.properties.hs_invoice_total || 'N/A'}...`);
    
    // 5. Crear la factura en QuickBooks
    const newQbInvoice = await quickbooksClient.createInvoice(qbInvoicePayload);
    
    // Extraemos el ID numérico y el número de factura visible (DocNumber) que asignó QuickBooks
    const qbInvoiceId = newQbInvoice.Id;
    const qbDocNumber = newQbInvoice.DocNumber; 
    
    console.log(`✅ Factura creada en QB. ID Interno: ${qbInvoiceId} | Número: ${qbDocNumber}`);

    // 6. Guardar los anclas (IDs) en HubSpot
    const propiedadesParaActualizar = {
        id_factura_quickbooks: qbInvoiceId.toString(),
        numero_factura_qb: qbDocNumber 
    };

    console.log(`🔗 Enlazando el Número de Factura (${qbDocNumber}) a HubSpot...`);
    await hubspotClient.updateInvoice(invoiceId, propiedadesParaActualizar);
    
    console.log(`🎉 ¡ÉXITO! Factura sincronizada y enlazada correctamente.`);
    console.log(`=========================================================\n`);

    return qbInvoiceId;

  } catch (error) {
    console.error(`❌ Error en la sincronización de la factura ${invoiceId}:`, error.message);
    throw error;
  }
}

module.exports = { syncInvoiceToQuickbooks };