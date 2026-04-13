const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const contactSyncService = require('./contact.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const mutex = require('../utils/mutex.util');

/**
 * Orquestador principal para sincronizar pagos de QuickBooks a HubSpot
 */
async function _internalProcessQuickbooksPayment(paymentId) {
    logger.info(`[Sync] Procesando Pago QB ID: ${paymentId}`, { source: 'QUICKBOOKS', entity: 'payment', entityId: paymentId });

    try {
        // 1. Obtener los detalles del pago desde QuickBooks
        const paymentData = await quickbooksClient.getPaymentDetails(paymentId);
        
        // 2. Buscar a qué factura está asociado este pago
        let qboInvoiceId = null;
        if (paymentData.Line && paymentData.Line.length > 0) {
            for (const line of paymentData.Line) {
                const linkedTxn = line.LinkedTxn.find(txn => txn.TxnType === 'Invoice');
                if (linkedTxn) {
                    qboInvoiceId = linkedTxn.TxnId;
                    break;
                }
            }
        }

        if (!qboInvoiceId) {
            logger.info(`[Pagos] ⚠️ El pago ${paymentId} no está vinculado a ninguna factura. Omitiendo.`);
            return;
        }

        logger.info(`[Pagos] Pago asociado a la Factura de QB ID: ${qboInvoiceId}. Consultando saldos...`);

        // 3. Consultar la factura original en QuickBooks
        const qboInvoice = await quickbooksClient.getInvoice(qboInvoiceId);
        
        const amountPaid = qboInvoice.TotalAmt - qboInvoice.Balance;
        const remainingBalance = qboInvoice.Balance;

        // 4. Buscar la factura en HubSpot
        const hsInvoice = await hubspotClient.searchInvoiceByCustomProperty('id_factura_quickbooks', qboInvoiceId);

        if (!hsInvoice) {
            logger.error(`[Pagos] ❌ No se encontró en HubSpot factura con ID QB: ${qboInvoiceId}`);
            return;
        }

        // --- DEEP COMPARE PARA PAGOS ---
        if (
            hsInvoice.properties.importe_pagado_qb === amountPaid.toString() &&
            hsInvoice.properties.saldo_pendiente_qb === remainingBalance.toString()
        ) {
            logger.info(`[Pagos] ⏩ Los saldos en HubSpot ya están actualizados. Omitiendo.`);
            return;
        }

        logger.info(`[Pagos] Factura HS ${hsInvoice.id} encontrada. Preparando actualización...`);

        const propertiesToUpdate = {
            importe_pagado_qb: amountPaid.toString(),
            saldo_pendiente_qb: remainingBalance.toString()
        };

        if (remainingBalance === 0) {
            propertiesToUpdate.estado_de_factura_qb = 'Pagada'; 
        } else if (amountPaid > 0) {
            propertiesToUpdate.estado_de_factura_qb = 'Emitida';
        } else {
            propertiesToUpdate.estado_de_factura_qb = 'Borrador';
        }

        // 6. Enviar el PATCH a HubSpot
        await hubspotClient.updateInvoice(hsInvoice.id, propertiesToUpdate);

        logger.info(`[Pagos] ✅ Factura HS ${hsInvoice.id} actualizada con éxito.`);

    } catch (error) {
        logger.error(`[Pagos] ❌ Error crítico procesando pago QB ${paymentId}:`, error);
    }
}

async function processQuickbooksPayment(paymentId) {
    return await _internalProcessQuickbooksPayment(paymentId);
}

/**
 * --- SINCRONIZACIÓN HS -> QB (PAGOS) ---
 * Escucha la creación de un pago en HubSpot, resuelve el cliente en QB
 * y crea un Unapplied Payment (sin asociar a factura).
 */
async function syncPaymentToQuickbooks(hsPaymentId) {
    logger.info(`[Sync] Iniciando sincronización de Pago HS ID: ${hsPaymentId}`, { source: 'HUBSPOT', entity: 'hs_payment', entityId: hsPaymentId });

    try {
        // 1. Obtener detalles del pago desde HubSpot
        const hsPayment = await hubspotClient.getPaymentDetails(hsPaymentId);
        if (!hsPayment) throw new Error(`El pago ${hsPaymentId} no existe en HubSpot.`);

        const refNumber = hsPayment.properties.hs_reference_number || '';
        const totalAmount = Number(hsPayment.properties.hs_total_collected_amount_after_refunds || 0);

        if (totalAmount <= 0) {
            logger.warn(`[Pagos HS→QB] ⚠️ El pago ${hsPaymentId} tiene monto $0 o negativo. Omitiendo.`);
            return;
        }

        // 2. Obtener el contacto asociado al pago en HS
        const contactAssociations = await hubspotClient.getPaymentAssociations(hsPaymentId, 'contacts');
        if (contactAssociations.length === 0) {
            throw new Error(`El pago HS ${hsPaymentId} no tiene un Contacto asociado. QuickBooks exige un Customer.`);
        }

        const contactId = contactAssociations[0];
        logger.info(`[Pagos HS→QB] Procesando Contacto Asociado (ID: ${contactId})...`);

        // 3. Resolver el Customer en QuickBooks
        const { qbCustomerId } = await contactSyncService.processContact(contactId);
        if (!qbCustomerId) throw new Error(`No se pudo resolver el ID de QuickBooks para el contacto ${contactId}`);

        // 4. Construir y enviar el payload a QuickBooks
        const qbPaymentPayload = {
            CustomerRef: { value: qbCustomerId.toString() },
            TotalAmt: totalAmount,
            PaymentRefNum: refNumber
        };

        logger.info(`💳 Enviando Pago a QuickBooks (Ref: ${refNumber}, Monto: $${totalAmount})...`);

        const newQbPayment = await quickbooksClient.createPayment(qbPaymentPayload);

        // 5. Echo suppression para que QB no lo re-procese
        echoSuppression.markAsCreatedInQb(newQbPayment.Id);

        logger.info(`🎉 Pago sincronizado correctamente: QB ${newQbPayment.Id} ← HS ${hsPaymentId}`);

        return newQbPayment.Id;

    } catch (error) {
        logger.error(`❌ Error sincronizando pago HS ${hsPaymentId} hacia QuickBooks:`, error);
        throw error;
    }
}

async function reconcilePaymentsForInvoice(hsInvoiceId, qbInvoiceId) {
    logger.info(`[Conciliación] Iniciando cruce de pagos para Factura HS ${hsInvoiceId} y QB ${qbInvoiceId}...`);
    try {
        // 1. Obtener los IDs de los pagos asociados a la factura en HubSpot (El objeto payment en HS suele ser 0-101)
        const paymentIds = await hubspotClient.getInvoiceAssociations(hsInvoiceId, '0-101'); 
        
        if (!paymentIds || paymentIds.length === 0) {
            logger.info(`[Conciliación] No hay pagos asociados en HS para la factura ${hsInvoiceId}.`);
            return;
        }

        logger.info(`[Conciliación] Se encontraron ${paymentIds.length} pagos en HS. Obteniendo referencias...`);

        // 2. Iterar sobre los pagos de HS para buscar su contraparte en QB
        for (const paymentId of paymentIds) {
            const hsPayment = await hubspotClient.getPaymentDetails(paymentId);
            if (!hsPayment) continue;

            const refNumber = hsPayment.properties.hs_reference_number;
            const paymentAmount = Number(hsPayment.properties.hs_total_collected_amount_after_refunds || 0);

            if (!refNumber) {
                logger.warn(`[Conciliación] El pago HS ${paymentId} no tiene referencia (hs_reference_number). Saltando.`);
                continue;
            }

            logger.info(`[Conciliación] Buscando en QB el pago con Referencia: "${refNumber}"...`);

            // 3. Buscar el pago en QuickBooks por su Referencia
            const qbPayments = await quickbooksClient.findPaymentByRefNumber(refNumber);

            if (!qbPayments || qbPayments.length === 0) {
                logger.warn(`[Conciliación] No se encontró el pago en QB con referencia "${refNumber}".`);
                continue;
            }

            const qbPayment = qbPayments[0]; // Tomamos el que coincida

            // Extraemos el ID del cliente que QB necesita
            const customerId = qbPayment.CustomerRef ? qbPayment.CustomerRef.value : null;

            if (!customerId) {
                 logger.warn(`[Conciliación] El pago QB ${qbPayment.Id} no tiene un cliente asociado. No se puede enlazar.`);
                 continue;
            }

            // 4. Enlazar el Pago de QB a la Factura de QB
            logger.info(`[Conciliación] Enlazando Pago QB ID ${qbPayment.Id} a Factura QB ID ${qbInvoiceId} por un monto de $${paymentAmount}...`);
            await quickbooksClient.linkPaymentToInvoice(qbPayment.Id, qbPayment.SyncToken, qbInvoiceId, paymentAmount, customerId);
            
            logger.info(`[Conciliación] ✅ Pago "${refNumber}" aplicado exitosamente a la factura.`);
        }
        
        logger.info(`[Conciliación] Fin del proceso de conciliación para la Factura HS ${hsInvoiceId}.`);
    } catch (error) {
        // Al imprimir error.message evitamos pasar el objeto completo al logger
        logger.error(`[Conciliación] ❌ Error durante la conciliación de la factura HS ${hsInvoiceId}: ${error.message}`);
    }
}

module.exports = {
    processQuickbooksPayment,
    syncPaymentToQuickbooks,
    reconcilePaymentsForInvoice
};