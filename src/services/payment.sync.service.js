const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const contactSyncService = require('./contact.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const Tenant = require('../db/models/tenant.model');
const { DEFAULT_TENANT_ID, CONTACT_STATUS_VALUES } = require('../config/constants');
const { InactiveCustomerError, CurrencyMismatchError } = require('../utils/errors.util');

/**
 * Lee el mapeo de cuentas de depósito del tenant y lo devuelve como objeto plano.
 * Estructura esperada en Mongo: tenant.preferences.depositAccounts = { CRC: "id1", USD: "id2" }.
 */
function readDepositAccounts(tenant) {
    const result = {};
    const raw = tenant?.preferences?.depositAccounts;
    if (!raw) return result;
    if (raw instanceof Map) {
        for (const [k, v] of raw.entries()) result[k] = v;
    } else if (typeof raw === 'object') {
        Object.assign(result, raw);
    }
    return result;
}

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
        const { qbCustomerId, contactInfo, status: contactStatus } = await contactSyncService.processContact(contactId, tenantId);

        // Fail-fast: si el contacto está inactivo, abortamos sin golpear QB.
        if (contactStatus === CONTACT_STATUS_VALUES.INACTIVE) {
            throw new InactiveCustomerError(`Pago HS ${hsPaymentId}: contacto ${contactId} está inactivo. No se crea el pago en QB.`);
        }

        // Validación de factura asociada + moneda.
        // El flujo de esta integración exige que el pago siempre venga linkeado a 1 factura HS.
        // Si falta (o hay múltiples con monedas distintas), rechazamos antes de tocar QB.
        const invoiceAssociations = await hubspotClient.getPaymentAssociations(hsPaymentId, '0-53');
        if (invoiceAssociations.length === 0) {
            throw new CurrencyMismatchError(`Pago HS ${hsPaymentId}: sin factura asociada. Los pagos deben registrarse desde los detalles de una factura en HS, o ingresarse directamente en QB.`);
        }
        if (invoiceAssociations.length > 1) {
            logger.warn(`⚠️ Pago HS ${hsPaymentId} asociado a ${invoiceAssociations.length} facturas (inusual). Validando cada una.`);
        }

        // Fetch QB customer para validación HS-vs-QB (CurrencyRef inmutable es la verdad).
        const qbCustomer = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
        if (!qbCustomer) {
            throw new Error(`No se pudo obtener QB customer ${qbCustomerId} para validar moneda del pago ${hsPaymentId}.`);
        }
        const contactCurrency = contactInfo?.preferredCurrency || "";
        const qbCustomerCurrency = qbCustomer.CurrencyRef?.value || "";

        // Validar cada factura asociada contra contacto y QB customer.
        let paymentCurrency = null;
        for (const invoiceId of invoiceAssociations) {
            const invoice = await hubspotClient.getInvoiceDetails(invoiceId);
            if (!invoice) {
                throw new Error(`No se pudo obtener la factura HS ${invoiceId} asociada al pago ${hsPaymentId}.`);
            }
            const invoiceCurrency = invoice.properties.hs_currency || "";

            if (invoiceCurrency !== contactCurrency) {
                throw new CurrencyMismatchError(
                    `Pago HS ${hsPaymentId}: factura HS ${invoiceId} hs_currency="${invoiceCurrency}" no coincide con moneda_de_preferencia="${contactCurrency}" del contacto ${contactId}.`
                );
            }
            if (invoiceCurrency !== qbCustomerCurrency) {
                throw new CurrencyMismatchError(
                    `Pago HS ${hsPaymentId}: factura HS ${invoiceId} hs_currency="${invoiceCurrency}" no coincide con CurrencyRef="${qbCustomerCurrency}" del QB customer ${qbCustomerId}.`
                );
            }

            if (paymentCurrency === null) {
                paymentCurrency = invoiceCurrency;
            } else if (paymentCurrency !== invoiceCurrency) {
                throw new CurrencyMismatchError(
                    `Pago HS ${hsPaymentId} asociado a facturas con monedas distintas ("${paymentCurrency}" y "${invoiceCurrency}"). No se puede crear en QB.`
                );
            }
        }

        // Routing del DepositToAccountRef según la moneda del pago.
        // Mapeo configurable por tenant en preferences.depositAccounts (ver configure-deposit-accounts.js).
        // Si no hay mapping para esta moneda → omitimos el field → QB usa la cuenta default.
        const tenant = await Tenant.findOne({ tenantId });
        const depositAccounts = readDepositAccounts(tenant);
        const depositAccountId = depositAccounts[paymentCurrency];

        const qbPaymentPayload = {
            CustomerRef: { value: qbCustomerId.toString() },
            TotalAmt: totalAmount,
            PaymentRefNum: refNumber
        };
        if (depositAccountId) {
            qbPaymentPayload.DepositToAccountRef = { value: String(depositAccountId) };
            logger.info(`💰 Pago HS ${hsPaymentId} ruteado a cuenta QB ${depositAccountId} (${paymentCurrency}).`);
        } else {
            logger.warn(`⚠️ Tenant ${tenantId} sin preferences.depositAccounts.${paymentCurrency} configurado. QB usará la cuenta default.`);
        }

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