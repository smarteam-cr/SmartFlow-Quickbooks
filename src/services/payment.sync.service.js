const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
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
            propertiesToUpdate.estado_de_factura_qb = 'Pago Parcial';
        } else {
            propertiesToUpdate.estado_de_factura_qb = 'Abierta';
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

module.exports = {
    processQuickbooksPayment
};