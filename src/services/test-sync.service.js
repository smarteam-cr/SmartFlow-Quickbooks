const qbClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');

async function executeSync() {
  console.log('[Service] Iniciando extracción de clientes desde QuickBooks...');
  
  const customers = await qbClient.getAllCustomers(); // Trae MAXRESULTS 4
  
  if (!customers || customers.length === 0) {
    return null; // El controlador manejará este estado
  }

  let resultados = { empresasCreadas: 0, contactosCreados: 0, asociaciones: 0 };

  for (const customer of customers) {
    const companyName = customer.CompanyName;
    const givenName = customer.GivenName;
    const familyName = customer.FamilyName;
    const email = customer.PrimaryEmailAddr?.Address;

    console.log(`\n[Service] Evaluando cliente QB: ${customer.DisplayName}`);

    // REGLA 3: Mixto (B2B - Tiene Empresa y Persona)
    if (companyName && (givenName || familyName)) {
      console.log(' -> Regla Mixta: Creando Empresa y Contacto...');
      const hsCompany = await hubspotClient.createCompany(companyName);
      resultados.empresasCreadas++;

      const hsContact = await hubspotClient.createSingleContact({
        firstname: givenName,
        lastname: familyName,
        email: email
      });
      resultados.contactosCreados++;

      await hubspotClient.associateContactToCompany(hsContact.id, hsCompany.id);
      resultados.asociaciones++;
      console.log(' -> Asociación exitosa.');
    } 
    // REGLA 1: Solo Empresa
    else if (companyName && !givenName && !familyName) {
      console.log(' -> Regla Empresa: Creando solo registro de Empresa...');
      await hubspotClient.createCompany(companyName);
      resultados.empresasCreadas++;
    } 
    // REGLA 2: Solo Contacto
    else if (!companyName && (givenName || familyName)) {
      console.log(' -> Regla Contacto: Creando solo registro de Contacto...');
      await hubspotClient.createSingleContact({
        firstname: givenName,
        lastname: familyName,
        email: email
      });
      resultados.contactosCreados++;
    } else {
      console.log(' -> Ignorado: Faltan datos clave (Sin empresa ni nombre).');
    }
  }

  return resultados;
}

module.exports = { executeSync };