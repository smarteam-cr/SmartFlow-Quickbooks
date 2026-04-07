const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const echoSuppression = require('../utils/echo.suppression.util');
const mutex = require('../utils/mutex.util');
const logger = require('../lib/logger.lib');

/**
 * --- SINCRONIZACIÓN HS -> QB (Empresas) ---
 * Procesa la creación o actualización de una empresa que viene de HubSpot.
 */
async function _internalProcessCompanyFromHubSpot(hsCompanyId) {
    logger.info(`[Sync] Procesando Empresa HS ID: ${hsCompanyId}`, { source: 'HUBSPOT', entity: 'company', entityId: hsCompanyId });

    try {
        // 1. Obtener datos de HubSpot
        const company = await hubspotClient.getCompanyDetails(hsCompanyId);
        if (!company) {
            logger.info(`❌ No se encontraron datos para la empresa HS ${hsCompanyId}.`);
            return;
        }

        const {
            name: companyName,
            nit,
            phone,
            domain,
            address,
            city,
            country
        } = company.properties;

        const id_usuario_quickbooks = company.properties.id_usuario_quickbooks;

        const customerData = {
            companyName,
            nit,
            phone,
            domain,
            address,
            city,
            country,
            hsId: hsCompanyId
        };

        let qbCustomerId = null;
        let existingCustomer = null;

        if (id_usuario_quickbooks) {
            existingCustomer = await quickbooksClient.getCustomerById(id_usuario_quickbooks).catch(() => null);
        }

        if (!existingCustomer && companyName) {
            logger.info(`🔍 Buscando empresa en QB por nombre: "${companyName}"...`);
            existingCustomer = await quickbooksClient.findCustomerByDisplayName(companyName);
        }

        if (existingCustomer) {
            qbCustomerId = existingCustomer.Id;
            const qbSyncToken = existingCustomer.SyncToken;

            logger.info(`🔄 Empresa ENCONTRADA (QB ID: ${qbCustomerId}). Validando cambios reales...`);

            const hasRealChanges = 
                (customerData.companyName !== (existingCustomer.CompanyName || existingCustomer.DisplayName)) ||
                (customerData.nit !== (existingCustomer.AlternatePhone?.FreeFormNumber || "")) ||
                (customerData.phone !== (existingCustomer.PrimaryPhone?.FreeFormNumber || "")) ||
                (customerData.domain !== (existingCustomer.WebAddr?.URI?.replace('https://', '') || "")) ||
                (customerData.address !== (existingCustomer.BillAddr?.Line1 || "")) ||
                (customerData.city !== (existingCustomer.BillAddr?.City || "")) ||
                (customerData.country !== (existingCustomer.BillAddr?.Country || ""));

            if (!hasRealChanges) {
                logger.info(`⏩ Sin cambios reales. Omitiendo actualización en QuickBooks (ECO).`);
            } else {
                logger.info(`📝 Cambios detectados. Actualizando empresa en QuickBooks...`);
                echoSuppression.markAsCreatedInQb(qbCustomerId);
                await quickbooksClient.updateCustomer(qbCustomerId, qbSyncToken, customerData);
            }
        } else {
            logger.info(`✨ Creando nueva empresa en QuickBooks: "${companyName}"...`);
            const newCustomer = await quickbooksClient.createCustomer(customerData);
            qbCustomerId = newCustomer.Id;
            echoSuppression.markAsCreatedInQb(qbCustomerId);
            logger.info(`✅ Empresa creada en QB con ID: ${qbCustomerId}`);
        }

        if (qbCustomerId && (!id_usuario_quickbooks || id_usuario_quickbooks !== qbCustomerId.toString())) {
            logger.info(`🔗 Enlazando ID de QuickBooks ${qbCustomerId} en HubSpot...`);
            echoSuppression.markAsCreatedInHs(hsCompanyId);
            await hubspotClient.updateCompanyProperty(hsCompanyId, qbCustomerId);
        }
    } catch (error) {
        logger.error(`❌ Error procesando empresa HS ${hsCompanyId}:`, error);
        throw error;
    }
}

async function processCompany(hsCompanyId) {
    return await _internalProcessCompanyFromHubSpot(hsCompanyId);   
}

module.exports = { processCompany };