const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service');
const qbMapper = require('../integrations/quickbooks/quickbooks.mapper');
const echoSuppression = require('../utils/echo.suppression.util');

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
    const { qbCustomerId, contactInfo } = await contactSyncService.processContact(contactId);
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
    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo);

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
    
    // 🌟 SUPRESIÓN DE ECO: Marcamos para ignorar el webhook inmediato de creación
    echoSuppression.markAsCreatedInQb(qbInvoiceId);
    
    // 6. Guardar el ancla (ID) y el estado inicial sencillo en HubSpot
    const propiedadesParaActualizar = {
        id_factura_quickbooks: qbInvoiceId.toString(),
        sistema_de_origen: "QuickBooks",
        numero_factura_qb: qbDocNumber,
        estado_de_factura_qb: 'Abierta'
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

/**
 * --- SINCRONIZACIÓN QB -> HS ---
 * Actualiza los saldos y estados de una factura en HubSpot desde QuickBooks.
 */
async function syncInvoiceFromQuickbooks(qbInvoiceId) {
  try {
    // 🛡️ SUPRESIÓN DE ECO: Ignorar si es un cambio generado por nosotros
    if (echoSuppression.wasCreatedInQb(qbInvoiceId)) {
        console.log(`♻️ [Echo] Ignorando factura ${qbInvoiceId} (cambio interno).`);
        return;
    }

    console.log(`\n📄 [QB -> HS] Actualizando info de la Factura de QB: ${qbInvoiceId}`);

    // 1. Obtener los detalles de la factura desde QuickBooks
    const qbInvoice = await quickbooksClient.getInvoice(qbInvoiceId);
    if (!qbInvoice) {
      console.warn(`[Invoice Sync] ⚠️ No se encontró la factura ${qbInvoiceId} en QuickBooks.`);
      return;
    }

    // 2. Buscar la factura en HubSpot usando nuestra propiedad ancla
    const hsInvoice = await hubspotClient.searchInvoiceByCustomProperty('id_factura_quickbooks', qbInvoiceId);
    if (!hsInvoice) {
      console.error(`[Invoice Sync] ❌ Error: No se encontró en HubSpot la factura con ID QB: ${qbInvoiceId}`);
      return;
    }

    // 3. Evaluar saldos
    const amountPaid = qbInvoice.TotalAmt - qbInvoice.Balance;
    const remainingBalance = qbInvoice.Balance;

    // 4. Preparar propiedades
    const propertiesToUpdate = {
      importe_pagado_qb: amountPaid.toString(),
      saldo_pendiente_qb: remainingBalance.toString()
    };

    // Lógica de estado según saldos y envío por email
    if (remainingBalance === 0) {
      propertiesToUpdate.estado_de_factura_qb = 'Pagada';
    } else if (amountPaid > 0) {
      propertiesToUpdate.estado_de_factura_qb = 'Pago Parcial';
    } else if (qbInvoice.EmailStatus === 'EmailSent') {
      propertiesToUpdate.estado_de_factura_qb = 'Enviada';
    } else {
      propertiesToUpdate.estado_de_factura_qb = 'Abierta';
    }

    // 5. Enviar el PATCH a HubSpot
    console.log(`[Invoice Sync] Actualizando saldos y estado (${propertiesToUpdate.estado_de_factura_qb}) en HS para la factura ${hsInvoice.id}...`);
    await hubspotClient.updateInvoice(hsInvoice.id, propertiesToUpdate);

    console.log(`[Invoice Sync] ✅ Éxito: Factura ${hsInvoice.id} actualizada.`);

  } catch (error) {
    console.error(`[Invoice Sync] ❌ Error sincronizando factura ${qbInvoiceId} hacia HubSpot:`, error.message);
    throw error;
  }
}

/**
 * --- SINCRONIZACIÓN HS -> QB (ACTUALIZACIÓN) ---
 * Escucha cambios en HubSpot y los refleja en una factura ya existente en QuickBooks.
 */
async function syncHubSpotInvoiceToQuickbooks(invoiceId) {
  try {
    console.log(`\n=== 🔄 ACTUALIZANDO FACTURA DESDE HUBSPOT: ${invoiceId} ===`);

    // 1. Obtener datos de la factura en HS
    const hsInvoice = await hubspotClient.getInvoiceDetails(invoiceId);
    if (!hsInvoice) throw new Error(`La factura ${invoiceId} no existe en HubSpot.`);

    const qbInvoiceId = hsInvoice.properties.id_factura_quickbooks;
    if (!qbInvoiceId) {
      console.log(`ℹ️ La factura ${invoiceId} no tiene ID de QuickBooks. Intentando creación inicial...`);
      return await syncInvoiceToQuickbooks(invoiceId);
    }

    // 🛡️ REGLA DE SEGURIDAD: Solo editar si está "Abierta" o sin estado
    const currentStatus = hsInvoice.properties.estado_de_factura_qb;
    if (currentStatus && currentStatus !== 'Abierta' && currentStatus !== '') {
      console.warn(`🛑 Bloqueo Contable: No se puede editar la factura ${invoiceId} porque su estado es "${currentStatus}".`);
      return;
    }

    // 2. Obtener el SyncToken actual desde QuickBooks
    console.log(`🔍 Obteniendo estado actual de la factura ${qbInvoiceId} en QuickBooks...`);
    const existingQbInvoice = await quickbooksClient.getInvoice(qbInvoiceId);
    if (!existingQbInvoice) {
        throw new Error(`La factura ${qbInvoiceId} no existe en QuickBooks.`);
    }
    const syncToken = existingQbInvoice.SyncToken;

    // 3. Resolver Contacto Actual (por si cambió)
    const contactAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'contacts');
    let qbCustomerId = existingQbInvoice.CustomerRef.value; // Por defecto el actual
    let contactInfo = null;

    if (contactAssociations.length > 0) {
      const contactId = contactAssociations[0];
      const resolution = await contactSyncService.processContact(contactId);
      qbCustomerId = resolution.qbCustomerId;
      contactInfo = resolution.contactInfo;
    }

    // 4. Resolver Productos Actuales (sobrescritura completa para consistencia)
    const lineItemAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'line_items');
    console.log(`📦 Refrescando ${lineItemAssociations.length} productos...`);
    
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);
    const qbInvoiceLines = [];

    for (const item of lineItemsData) {
      let qbItemId = item.properties.id_producto_quickbooks;
      
      if (!qbItemId) {
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

      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId);
      qbInvoiceLines.push(mappedLine);
    }

    // 5. Mapear Payload y Actualizar
    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo);
    
    console.log(`📝 Enviando actualización a QuickBooks (ID: ${qbInvoiceId})...`);
    echoSuppression.markAsCreatedInQb(qbInvoiceId); // Evitar eco de vuelta
    await quickbooksClient.updateInvoice(qbInvoiceId, syncToken, qbInvoicePayload);

    console.log(`✅ Factura ${invoiceId} actualizada correctamente en QuickBooks.`);
    
  } catch (error) {
    console.error(`❌ Error actualizando factura ${invoiceId} hacia QuickBooks:`, error.message);
    throw error;
  }
}

module.exports = { 
  syncInvoiceToQuickbooks, 
  syncInvoiceFromQuickbooks,
  syncHubSpotInvoiceToQuickbooks 
};