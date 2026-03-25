const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');

async function processCompany(hsCompanyId) {
  try {
    // 1. Buscamos los datos de la empresa recién creada en HubSpot
    const company = await hubspotClient.getCompanyDetails(hsCompanyId);
    if (!company) return;

    const companyName = company.properties.name || company.properties.domain || `Company-${hsCompanyId}`;
    const existingQbId = company.properties.id_usuario_quickbooks;

    // Si por alguna razón ya tiene ID, abortamos para no duplicar
    if (existingQbId) {
      console.log(`[Real-Time] La empresa "${companyName}" ya tiene QB ID: ${existingQbId}. Omitiendo.`);
      return;
    }

    console.log(`[Real-Time] Procesando nueva empresa B2B: "${companyName}"`);

    // 2. Verificamos si ya existe en QB (por si la crearon manual allá primero)
    const existingCustomer = await quickbooksClient.findCustomerByDisplayName(companyName);
    let finalQbId = null;

    if (existingCustomer) {
      console.log(`[Real-Time] ✓ Ya existe en QB (ID: ${existingCustomer.Id}). Reusando.`);
      finalQbId = existingCustomer.Id;
    } else {
      console.log(`[Real-Time] → Creando empresa pura (Padre) en QuickBooks...`);
      const newCustomer = await quickbooksClient.createCustomer({
        companyName: companyName,
        hsId: hsCompanyId,
      });
      console.log(`[Real-Time] ✓ Empresa creada en QB con ID: ${newCustomer.Id}`);
      finalQbId = newCustomer.Id;
    }

    // 3. Guardamos el ID de vuelta en HubSpot
    if (finalQbId) {
      await hubspotClient.updateCompanyProperty(hsCompanyId, finalQbId);
      console.log(`[Real-Time] ✓ HubSpot actualizado con el QB ID: ${finalQbId}`);
    }

  } catch (error) {
    console.error(`[Real-Time] ✗ Error procesando empresa ${hsCompanyId}:`, error.message);
  }
}

module.exports = { processCompany };