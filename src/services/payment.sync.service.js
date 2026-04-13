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

module.exports = {
    processQuickbooksPayment,
    syncPaymentToQuickbooks
};