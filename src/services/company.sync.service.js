const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');
const { MissingNitError } = require('../utils/errors.util');

function normalizeHsCompanyToQb(company) {
    const props = company.properties || {};
    const nit = props.nit || "";
    const companyName = props.name || "";
    const displayName = nit
        ? `${companyName} ${nit}`.trim()
        : companyName || props.domain || `Company-${company.id}`;
    return {
        companyName, nit, phone: props.phone || "",
        domain: props.domain || "", address: props.address || "", city: props.city || "",
        state: props.state || "", zip: props.zip || "", country: props.country || "",
        preferredCurrency: props.moneda_de_preferencia || "",
        displayName
    };
}

function normalizeQbCompanyToHs(qbCustomer) {
    return {
        name: qbCustomer.CompanyName || qbCustomer.DisplayName || "",
        nit: qbCustomer.AlternatePhone?.FreeFormNumber || "", phone: qbCustomer.PrimaryPhone?.FreeFormNumber || "",
        domain: (qbCustomer.WebAddr?.URI || "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase(),
        address: qbCustomer.BillAddr?.Line1 || "", city: qbCustomer.BillAddr?.City || "",
        state: qbCustomer.BillAddr?.CountrySubDivisionCode || "", zip: qbCustomer.BillAddr?.PostalCode || "",
        country: qbCustomer.BillAddr?.Country || "",
        id_usuario_quickbooks: qbCustomer.Id.toString()
    };
}

function generateHash(payload) {
    return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * --- HS -> QB (Empresas) ---
 */
async function processCompany(hsCompanyId, tenantId = DEFAULT_TENANT_ID) {
    if (echoSuppression.wasCreatedInHs(hsCompanyId)) {
        logger.info(`♻️ [Echo Check] Ignorando evento de Empresa HS ID ${hsCompanyId} (generado internamente).`);
        return null;
    }

    logger.info(`[Sync] Procesando Empresa HS ID: ${hsCompanyId}`, { source: 'HUBSPOT', entity: 'company', entityId: hsCompanyId, tenantId });

    const company = await hubspotClient.getCompanyDetails(hsCompanyId);
    if (!company) return null;

    if (!company.properties?.nit) {
        throw new MissingNitError(`Empresa HS ${hsCompanyId} sin NIT. Se omite el sync con QuickBooks.`);
    }

    const normalizedData = normalizeHsCompanyToQb(company);
    const newHash = generateHash(normalizedData);
    const mapping = await mappingService.findByHsId(tenantId, 'company', hsCompanyId);
    let qbCustomerId = null;

    if (mapping && mapping.qbId) {
        qbCustomerId = mapping.qbId;
        if (mapping.payloadHash === newHash) {
            logger.info(`⏩ Empresa sin cambios reales (Hash coincide). Omitiendo QB.`);
            return { qbCustomerId };
        }

        logger.info(`📝 Actualizando empresa en QuickBooks...`);

        // 🛡️ FIX (Error 400): Traer el SyncToken más reciente justo antes de actualizar
        const currentQbData = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
        if (!currentQbData) {
            logger.warn(`⚠️ Empresa QB ${qbCustomerId} no encontrada. No se puede actualizar.`);
            return { qbCustomerId };
        }

        echoSuppression.markAsCreatedInQb(qbCustomerId);
        const updated = await quickbooksClient.updateCustomer(qbCustomerId, currentQbData.SyncToken, normalizedData);

        await mappingService.upsertMapping({
            tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
            qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
        });
    } else {
        let existingQb = await quickbooksClient.findCompanyByNit(normalizedData.nit);
        if (!existingQb) {
            existingQb = await quickbooksClient.createCustomer(normalizedData);
            echoSuppression.markAsCreatedInQb(existingQb.Id);
        }
        qbCustomerId = existingQb.Id;

        await mappingService.upsertMapping({
            tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
            qbSyncToken: existingQb.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
        });
        echoSuppression.markAsCreatedInHs(hsCompanyId);
        await hubspotClient.updateCompanyProperty(hsCompanyId, qbCustomerId);
    }
    return { qbCustomerId };
}

/**
 * --- QB -> HS (Empresas) ---
 */
async function syncCompanyFromQuickbooks(qbCustomerId, tenantId = DEFAULT_TENANT_ID) {
    logger.info(`[Sync] Sincronizando Empresa QB ID: ${qbCustomerId} hacia HubSpot`);

    if (echoSuppression.wasCreatedInQb(qbCustomerId)) return;

    const qbCustomer = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
    if (!qbCustomer) return;

    const hsProps = normalizeQbCompanyToHs(qbCustomer);
    const newHash = generateHash(hsProps);
    const mapping = await mappingService.findByQbId(tenantId, 'company', qbCustomerId);
    let hsCompanyId = mapping ? mapping.hsId : null;

    if (hsCompanyId) {
        if (mapping.payloadHash === newHash) {
            logger.info(`⏩ Empresa sin cambios reales (Hash coincide). Omitiendo actualización en HS.`);
        } else {
            echoSuppression.markAsCreatedInHs(hsCompanyId);
            await hubspotClient.updateCompany(hsCompanyId, hsProps);
            await mappingService.upsertMapping({
                tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
                qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
            });
        }
    } else {
        hsCompanyId = await hubspotClient.searchCompanyByQbId(qbCustomerId);
        if (hsCompanyId) {
            echoSuppression.markAsCreatedInHs(hsCompanyId);
            await hubspotClient.updateCompany(hsCompanyId, hsProps);
        } else {
            const newCompany = await hubspotClient.createCompany(hsProps);
            hsCompanyId = newCompany.id;
            echoSuppression.markAsCreatedInHs(hsCompanyId);
        }
        await mappingService.upsertMapping({
            tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
            qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
        });
    }
}

module.exports = { processCompany, syncCompanyFromQuickbooks };