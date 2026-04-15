const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const contactSyncService = require('./contact.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

/**
 * --- SINCRONIZACIÓN HS -> QB (PAGOS) ---
 * Escucha la creación de un pago en HubSpot, resuelve el cliente en QB
 * y crea un Unapplied Payment (sin asociar a factura).
 */
async function syncPaymentToQuickbooks(hsPaymentId, tenantId = DEFAULT_TENANT_ID) {
    if (echoSuppression.wasCreatedInHs(hsPaymentId)) return;
    
    logger.info(`[Sync] Sincronizando Pago HS ID: ${hsPaymentId} -> QB`, { source: 'HUBSPOT', entity: 'hs_payment', entityId: hsPaymentId, tenantId });

    try {
        const hsPayment = await hubspotClient.getPaymentDetails(hsPaymentId);
        if (!hsPayment) return;

        const refNumber = hsPayment.properties.hs_reference_number || '';
        const totalAmount = Number(hsPayment.properties.hs_total_collected_amount_after_refunds || 0);

        if (totalAmount <= 0) return;

        const contactAssociations = await hubspotClient.getPaymentAssociations(hsPaymentId, 'contacts');
        if (contactAssociations.length === 0) throw new Error(`Pago HS ${hsPaymentId} sin contacto.`);

        const contactId = contactAssociations[0];
        const { qbCustomerId } = await contactSyncService.processContact(contactId, tenantId);

        const qbPaymentPayload = {
            CustomerRef: { value: qbCustomerId.toString() },
            TotalAmt: totalAmount,
            PaymentRefNum: refNumber
        };

        const newQbPayment = await quickbooksClient.createPayment(qbPaymentPayload);

        logger.info(`🎉 Pago sincronizado: QB ${newQbPayment.Id}`);
        return newQbPayment.Id;

    } catch (error) {
        logger.error(`❌ Error en syncPaymentToQuickbooks: ${error.message}`);
        throw error;
    }
}

async function reconcilePaymentsForInvoice(hsInvoiceId, qbInvoiceId, tenantId = DEFAULT_TENANT_ID) {
    logger.info(`[Conciliación] Iniciando cruce para Factura HS ${hsInvoiceId}`, { tenantId });
    try {
        const paymentIds = await hubspotClient.getInvoiceAssociations(hsInvoiceId, '0-101'); 
        if (!paymentIds || paymentIds.length === 0) return;

        for (const paymentId of paymentIds) {
            const hsPayment = await hubspotClient.getPaymentDetails(paymentId);
            if (!hsPayment) continue;

            const refNumber = hsPayment.properties.hs_reference_number;
            const paymentAmount = Number(hsPayment.properties.hs_total_collected_amount_after_refunds || 0);

            if (!refNumber) continue;

            const qbPayments = await quickbooksClient.findPaymentByRefNumber(refNumber);
            if (!qbPayments || qbPayments.length === 0) continue;

            const qbPayment = qbPayments[0];
            const customerId = qbPayment.CustomerRef?.value;

            if (!customerId) continue;

            logger.info(`[Conciliación] Enlazando Pago QB ID ${qbPayment.Id} a Factura QB ID ${qbInvoiceId}`);
            await quickbooksClient.linkPaymentToInvoice(qbPayment.Id, qbPayment.SyncToken, qbInvoiceId, paymentAmount, customerId);
        }
    } catch (error) {
        logger.error(`[Conciliación] Error: ${error.message}`);
    }
}

module.exports = {
    syncPaymentToQuickbooks,
    reconcilePaymentsForInvoice
};