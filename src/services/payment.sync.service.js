const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');

const mutex = require('../utils/mutex.util');

/**
 * Orquestador principal para sincronizar pagos de QuickBooks a HubSpot
 * @param {string} paymentId - El ID del pago proveniente del webhook de QuickBooks
 */
async function _internalProcessQuickbooksPayment(paymentId) {
    try {
        console.log(`\n💰 [Pagos] Iniciando sincronización para el Payment ID de QB: ${paymentId}`);

        // 1. Obtener los detalles del pago desde QuickBooks
        const paymentData = await quickbooksClient.getPaymentDetails(paymentId);
        
        // 2. Buscar a qué factura está asociado este pago
        let qboInvoiceId = null;
        if (paymentData.Line && paymentData.Line.length > 0) {
            for (const line of paymentData.Line) {
                // Buscamos dentro de las transacciones vinculadas (LinkedTxn) la que sea de tipo Invoice
                const linkedTxn = line.LinkedTxn.find(txn => txn.TxnType === 'Invoice');
                if (linkedTxn) {
                    qboInvoiceId = linkedTxn.TxnId;
                    break;
                }
            }
        }

        if (!qboInvoiceId) {
            console.log(`[Pagos] ⚠️ El pago ${paymentId} no está vinculado a ninguna factura. Omitiendo sincronización.`);
            return;
        }

        console.log(`[Pagos] Pago asociado a la Factura de QB ID: ${qboInvoiceId}. Consultando saldos...`);

        // 3. Consultar la factura original en QuickBooks para ver su saldo real
        const qboInvoice = await quickbooksClient.getInvoice(qboInvoiceId);
        
        // Calculamos cuánto se ha pagado en total restando el saldo actual del monto total
        const amountPaid = qboInvoice.TotalAmt - qboInvoice.Balance;
        const remainingBalance = qboInvoice.Balance;

        // 4. Buscar la factura en HubSpot usando nuestra propiedad ancla
        const hsInvoice = await hubspotClient.searchInvoiceByCustomProperty('id_factura_quickbooks', qboInvoiceId);

        if (!hsInvoice) {
            console.error(`[Pagos] ❌ Error: No se encontró en HubSpot ninguna factura con ID de QBO: ${qboInvoiceId}`);
            return;
        }

        // --- DEEP COMPARE PARA PAGOS ---
        // Verificamos si los valores en HubSpot ya son iguales a los de QuickBooks
        if (
            hsInvoice.properties.importe_pagado_qb === amountPaid.toString() &&
            hsInvoice.properties.saldo_pendiente_qb === remainingBalance.toString()
        ) {
            console.log(`[Pagos] ⏩ Los saldos en HubSpot ya están actualizados. Omitiendo PATCH redundante.`);
            return;
        }

        console.log(`[Pagos] Factura encontrada en HubSpot (ID: ${hsInvoice.id}). Preparando actualización...`);

      // 5. Preparar el payload para actualizar HubSpot
        const propertiesToUpdate = {
            importe_pagado_qb: amountPaid.toString(),
            saldo_pendiente_qb: remainingBalance.toString()
        };

        // Lógica del semáforo: Actualizamos nuestro estado personalizado
        if (remainingBalance === 0) {
            propertiesToUpdate.estado_de_factura_qb = 'Pagada'; 
        } else if (amountPaid > 0) {
            propertiesToUpdate.estado_de_factura_qb = 'Pago Parcial';
        } else {
            propertiesToUpdate.estado_de_factura_qb = 'Abierta';
        }

        // 6. Enviar el PATCH a HubSpot para actualizar la factura
        await hubspotClient.updateInvoice(hsInvoice.id, propertiesToUpdate);

        console.log(`[Pagos] ✅ Éxito: Factura ${hsInvoice.id} en HubSpot actualizada.`);

    } catch (error) {
        console.error(`[Pagos] ❌ Error crítico procesando el pago ${paymentId}:`, error.message);
    }
}

async function processQuickbooksPayment(paymentId) {
    return await _internalProcessQuickbooksPayment(paymentId);
}

module.exports = {
    processQuickbooksPayment
};