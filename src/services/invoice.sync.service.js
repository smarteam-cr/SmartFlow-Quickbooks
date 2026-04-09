const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const contactSyncService = require('./contact.sync.service');
const qbMapper = require('../integrations/quickbooks/quickbooks.mapper');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');

async function syncInvoiceToQuickbooks(invoiceId) {
  logger.info(`[Sync] Iniciando Sincronización de Factura HS ID: ${invoiceId}`, { source: 'HUBSPOT', entity: 'invoice', entityId: invoiceId });

  try {
    // 1. Obtener la factura y validar idempotencia
    const hsInvoice = await hubspotClient.getInvoiceDetails(invoiceId);
    if (!hsInvoice) throw new Error(`La factura ${invoiceId} no existe en HubSpot.`);

    if (hsInvoice.properties.id_factura_quickbooks) {
      logger.info(`✅ Factura HS ${invoiceId} ya existe en QuickBooks (ID: ${hsInvoice.properties.id_factura_quickbooks}). Omitiendo.`);
      return hsInvoice.properties.id_factura_quickbooks;
    }

    // 2. Obtener y validar el Contacto Asociado (Regla de negocio: Obligatorio)
    const contactAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'contacts');
    if (contactAssociations.length === 0) {
      throw new Error(`La factura ${invoiceId} no tiene un Contacto asociado en HubSpot. QuickBooks exige un Customer.`);
    }

    const contactId = contactAssociations[0];
    logger.info(`👤 Procesando Contacto Asociado (ID: ${contactId})...`);

    // Invocamos el servicio de contacto
    const { qbCustomerId, contactInfo } = await contactSyncService.processContact(contactId);
    if (!qbCustomerId) throw new Error(`No se pudo resolver el ID de QuickBooks para el contacto ${contactId}`);

    // 3. Obtener y validar los Productos (Line Items)
    const lineItemAssociations = await hubspotClient.getInvoiceAssociations(invoiceId, 'line_items');
    if (lineItemAssociations.length === 0) {
      throw new Error(`La factura ${invoiceId} no tiene productos (Line Items) asociados.`);
    }

    logger.info(`📦 Procesando ${lineItemAssociations.length} Productos (Line Items)...`);
    const lineItemsData = await hubspotClient.getLineItemsDetails(lineItemAssociations);

    const qbInvoiceLines = [];
    let facturaLlevaImpuestos = false;

    for (const item of lineItemsData) {
      let qbItemId = item.properties.id_producto_quickbooks;

      if (!qbItemId) {
        logger.info(`   ⚠️ El producto "${item.properties.name}" no está en QuickBooks. Creándolo al vuelo...`);
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

      if (item.properties.es_gravable === "true") {
        facturaLlevaImpuestos = true;
      }

      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId);
      qbInvoiceLines.push(mappedLine);
    }

    const qbInvoicePayload = qbMapper.mapInvoicePayload(hsInvoice, qbCustomerId, qbInvoiceLines, contactInfo);

    if (facturaLlevaImpuestos) {
      logger.info('Se detectaron productos gravables. (Pendiente inyectar TxnTaxDetail)');
    }

    logger.info(`📝 Enviando Factura a QuickBooks por un total de $${hsInvoice.properties.hs_invoice_total || 'N/A'}...`);

    const newQbInvoice = await quickbooksClient.createInvoice(qbInvoicePayload);

    const qbInvoiceId = newQbInvoice.Id;
    const qbDocNumber = newQbInvoice.DocNumber;

    echoSuppression.markAsCreatedInQb(qbInvoiceId);

    const propiedadesParaActualizar = {
      id_factura_quickbooks: qbInvoiceId.toString(),
      sistema_de_origen: "Quickbooks",
      numero_factura_qb: qbDocNumber,
      estado_de_factura_qb: 'Borrador'
    };

    logger.info(`🔗 Enlazando el Número de Factura QB (${qbDocNumber}) a HubSpot...`);
    await hubspotClient.updateInvoice(invoiceId, propiedadesParaActualizar);

    logger.info(`🎉 Factura sincronizada y enlazada correctamente: QB ${qbInvoiceId} <-> HS ${invoiceId}`);

    return qbInvoiceId;
  } catch (error) {
    logger.error(`❌ Error en la sincronización de la factura HS ${invoiceId}:`, error);
    throw error;
  }
}

/**
 * --- SINCRONIZACIÓN QB -> HS ---
 * Actualiza los saldos y estados de una factura en HubSpot desde QuickBooks.
 */
async function syncInvoiceFromQuickbooks(qbInvoiceId) {
  logger.info(`[Sync] Actualizando Factura QB ID: ${qbInvoiceId} hacia HubSpot`, { source: 'QUICKBOOKS', entity: 'invoice', entityId: qbInvoiceId });

  try {
    if (echoSuppression.wasCreatedInQb(qbInvoiceId)) {
      logger.info(`♻️ [Echo] Ignorando factura QB ${qbInvoiceId} (cambio interno).`);
      return;
    }

    // 1. Obtener los detalles de la factura desde QuickBooks
    const qbInvoice = await quickbooksClient.getInvoice(qbInvoiceId);
    if (!qbInvoice) {
      logger.warn(`[Invoice Sync] ⚠️ No se encontró la factura QB ${qbInvoiceId} en QuickBooks.`);
      return;
    }

    // 2. Buscar la factura en HubSpot usando nuestra propiedad ancla
    const hsInvoice = await hubspotClient.searchInvoiceByCustomProperty('id_factura_quickbooks', qbInvoiceId);
    if (!hsInvoice) {
      logger.error(`[Invoice Sync] ❌ No se encontró en HubSpot factura con ID QB: ${qbInvoiceId}`);
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
      propertiesToUpdate.estado_de_factura_qb = 'Emitida';
    } else if (qbInvoice.EmailStatus === 'EmailSent') {
      propertiesToUpdate.estado_de_factura_qb = 'Enviada';
    } else {
      propertiesToUpdate.estado_de_factura_qb = 'Borrador';
    }

    // 5. Enviar el PATCH a HubSpot
    logger.info(`[Invoice Sync] Actualizando saldos y estado (${propertiesToUpdate.estado_de_factura_qb}) en HS para factura ${hsInvoice.id}...`);
    await hubspotClient.updateInvoice(hsInvoice.id, propertiesToUpdate);

    logger.info(`[Invoice Sync] ✅ Factura HS ${hsInvoice.id} actualizada correctamente.`);

  } catch (error) {
    logger.error(`[Invoice Sync] ❌ Error sincronizando factura QB ${qbInvoiceId} hacia HubSpot:`, error);
    throw error;
  }
}

/**
 * --- SINCRONIZACIÓN HS -> QB (ACTUALIZACIÓN) ---
 * Escucha cambios en HubSpot y los refleja en una factura ya existente en QuickBooks.
 */
async function syncHubSpotInvoiceToQuickbooks(invoiceId) {
  logger.info(`[Sync] Actualizando Factura HS ID: ${invoiceId} hacia QuickBooks`, { source: 'HUBSPOT', entity: 'invoice', entityId: invoiceId });

  try {
    // 1. Obtener datos de la factura en HS
    const hsInvoice = await hubspotClient.getInvoiceDetails(invoiceId);
    if (!hsInvoice) throw new Error(`La factura ${invoiceId} no existe en HubSpot.`);

    const qbInvoiceId = hsInvoice.properties.id_factura_quickbooks;
    if (!qbInvoiceId) {
      logger.info(`ℹ️ Factura HS ${invoiceId} aún no tiene ID de QB. Este evento se omite, la creación la maneja object.creation.`);
      return;
    }

    // 🛡️ REGLA DE SEGURIDAD: Solo editar si está "Abierta" o sin estado
    const currentStatus = hsInvoice.properties.estado_de_factura_qb;
    if (currentStatus && currentStatus !== 'Abierta' && currentStatus !== '') {
      logger.warn(`🛑 Bloqueo Contable: No se puede editar la factura HS ${invoiceId} porque su estado es "${currentStatus}".`);
      return;
    }

    // 2. Obtener el SyncToken actual desde QuickBooks
    logger.info(`🔍 Obteniendo estado actual de la factura QB ${qbInvoiceId} en QuickBooks...`);
    const existingQbInvoice = await quickbooksClient.getInvoice(qbInvoiceId);
    if (!existingQbInvoice) {
      throw new Error(`La factura QB ${qbInvoiceId} no existe en QuickBooks.`);
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
    logger.info(`📦 Refrescando ${lineItemAssociations.length} productos...`);

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

    logger.info(`📝 Enviando actualización a QuickBooks (QB ID: ${qbInvoiceId})...`);
    echoSuppression.markAsCreatedInQb(qbInvoiceId);
    await quickbooksClient.updateInvoice(qbInvoiceId, syncToken, qbInvoicePayload);

    logger.info(`✅ Factura HS ${invoiceId} actualizada correctamente en QuickBooks.`);

  } catch (error) {
    logger.error(`❌ Error actualizando factura HS ${invoiceId} hacia QuickBooks:`, error);
    throw error;
  }
}

module.exports = {
  syncInvoiceToQuickbooks,
  syncInvoiceFromQuickbooks,
  syncHubSpotInvoiceToQuickbooks
};