const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const echoSuppression = require('../utils/echo.suppression.util');
const mutex = require('../utils/mutex.util');

/**
 * --- SINCRONIZACIÓN HS -> QB (Empresas) ---
 * Procesa la creación o actualización de una empresa que viene de HubSpot.
 */
async function _internalProcessCompanyFromHubSpot(hsCompanyId) {
    console.log(`\n--- 🏢 Procesando Empresa HS ID: ${hsCompanyId} ---`);

    // 1. Obtener datos de HubSpot
    const company = await hubspotClient.getCompanyDetails(hsCompanyId);
    if (!company) {
        console.log(`❌ No se encontraron datos para la empresa ${hsCompanyId}.`);
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

    // 2. Mapeo de datos para QuickBooks (SRP: Preparar el objeto de negocio)
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

    // 3. Resolución de Idempotencia y Existencia
    let qbCustomerId = null;
    let existingCustomer = null;

    if (id_usuario_quickbooks) {
        existingCustomer = await quickbooksClient.getCustomerById(id_usuario_quickbooks).catch(() => null);
    }

    if (!existingCustomer && companyName) {
        console.log(`🔍 Buscando empresa en QB por nombre: "${companyName}"...`);
        existingCustomer = await quickbooksClient.findCustomerByDisplayName(companyName);
    }

    // 4. Lógica de Sincronización
    if (existingCustomer) {
        qbCustomerId = existingCustomer.Id;
        const qbSyncToken = existingCustomer.SyncToken;

        console.log(`🔄 Empresa ENCONTRADA (QB ID: ${qbCustomerId}). Validando cambios reales...`);

        // --- DEEP COMPARE ---
        const hasRealChanges = 
            (customerData.companyName !== (existingCustomer.CompanyName || existingCustomer.DisplayName)) ||
            (customerData.nit !== (existingCustomer.AlternatePhone?.FreeFormNumber || "")) ||
            (customerData.phone !== (existingCustomer.PrimaryPhone?.FreeFormNumber || "")) ||
            (customerData.domain !== (existingCustomer.WebAddr?.URI?.replace('https://', '') || "")) ||
            (customerData.address !== (existingCustomer.BillAddr?.Line1 || "")) ||
            (customerData.city !== (existingCustomer.BillAddr?.City || "")) ||
            (customerData.country !== (existingCustomer.BillAddr?.Country || ""));

        if (!hasRealChanges) {
            console.log(`⏩ Sin cambios reales. Omitiendo actualización en QuickBooks (ECO).`);
        } else {
            console.log(`📝 Cambios detectados. Actualizando empresa en QuickBooks...`);
            echoSuppression.markAsCreatedInQb(qbCustomerId);
            await quickbooksClient.updateCustomer(qbCustomerId, qbSyncToken, customerData);
        }
    } else {
        // === CREACIÓN ===
        console.log(`✨ Creando nueva empresa en QuickBooks: "${companyName}"...`);
        const newCustomer = await quickbooksClient.createCustomer(customerData);
        qbCustomerId = newCustomer.Id;
        echoSuppression.markAsCreatedInQb(qbCustomerId);
        console.log(`✅ Empresa creada en QB con ID: ${qbCustomerId}`);
    }

    // 5. Vincular el ID en HubSpot si es necesario
    if (qbCustomerId && (!id_usuario_quickbooks || id_usuario_quickbooks !== qbCustomerId.toString())) {
        console.log(`🔗 Enlazando ID de QuickBooks ${qbCustomerId} en HubSpot...`);
        echoSuppression.markAsCreatedInHs(hsCompanyId);
        await hubspotClient.updateCompanyProperty(hsCompanyId, qbCustomerId);
    }
}

/**
 * Función pública con Mutex (Sequential Processing)
 */
async function processCompany(hsCompanyId) {
    return await _internalProcessCompanyFromHubSpot(hsCompanyId);   
}

module.exports = { processCompany };