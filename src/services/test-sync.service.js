const qbClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');

async function executeSync() {
  console.log('[Service] Iniciando extracción de clientes desde QuickBooks...');
  
  const customers = await qbClient.getAllCustomers();
  
  if (!customers || customers.length === 0) {
    return null; // El controlador manejará este estado
  }

  // 1. EL TRUCO ARQUITECTÓNICO: Ordenar el array para evitar fallos de asociación.
  // Los clientes SIN ParentRef (Padres/Empresas) van primero. Los Hijos van después.
  customers.sort((a, b) => {
    if (!a.ParentRef && b.ParentRef) return -1;
    if (a.ParentRef && !b.ParentRef) return 1;
    return 0;
  });

  let resultados = { empresasCreadas: 0, contactosCreados: 0, asociaciones: 0 };

  for (const customer of customers) {
    // Extracción de IDs vitales
    const qbId = customer.Id; 
    const parentId = customer.ParentRef?.value; 
    
    // Extracción de datos básicos
    const givenName = customer.GivenName || '';
    const familyName = customer.FamilyName || '';
    const email = customer.PrimaryEmailAddr?.Address || '';
    
    // Si es empresa pura, usamos CompanyName (o DisplayName como plan B)
    const nombreEmpresa = customer.CompanyName || customer.DisplayName;

    console.log(`\n[Service] Evaluando QB ID [${qbId}]: ${customer.DisplayName}`);

    // REGLA 1: EMPRESA PURA (Padre) -> No tiene Padre, y no tiene nombre de persona
    if (!parentId && !givenName && !familyName) {
      console.log(` -> Detectado como EMPRESA PADRE. Verificando en HubSpot...`);
      let hsCompanyId = await hubspotClient.searchCompanyByQbId(qbId);

      if (!hsCompanyId) {
        console.log(` -> No existe. Creando Empresa en HubSpot...`);
        // Le pasamos el nombre Y su ID de QuickBooks para guardarlo
        await hubspotClient.createCompany(nombreEmpresa, qbId);
        resultados.empresasCreadas++;
      } else {
        console.log(` -> La empresa ya existe (HS ID: ${hsCompanyId}). Omitiendo.`);
      }
    } 
    
    // REGLA 2: CONTACTO DE EMPRESA (Hijo) -> Tiene un ParentRef (Pertenece a un Padre)
    else if (parentId) {
      console.log(` -> Detectado como EMPLEADO (Hijo). Pertenece al Padre ID: ${parentId}`);
      
      // A. Buscamos a la empresa Padre en HubSpot usando el ID del Padre
      let hsCompanyId = await hubspotClient.searchCompanyByQbId(parentId);
      
      // B. Creamos el Contacto y le guardamos su propio ID de QuickBooks (qbId)
      const hsContact = await hubspotClient.createSingleContact({
        firstname: givenName,
        lastname: familyName,
        email: email
      }, qbId);
      resultados.contactosCreados++;

      // C. Los Asociamos (Solo si el Padre fue encontrado en HubSpot)
      if (hsCompanyId && hsContact.id) {
        await hubspotClient.associateContactToCompany(hsContact.id, hsCompanyId);
        resultados.asociaciones++;
        console.log(' -> Asociación exitosa entre empleado y empresa.');
      } else {
        console.warn(` -> ALERTA: No se pudo asociar. La empresa Padre [${parentId}] no fue encontrada en HubSpot.`);
      }
    }
    
    // REGLA 3: CONTACTO INDIVIDUAL (B2C) -> No tiene Padre, pero sí tiene nombre propio
    else if (!parentId && (givenName || familyName)) {
        console.log(' -> Detectado como CONTACTO INDIVIDUAL. Creando en HubSpot...');
        await hubspotClient.createSingleContact({
          firstname: givenName,
          lastname: familyName,
          email: email
        }, qbId);
        resultados.contactosCreados++;
    } else {
        console.log(' -> Ignorado: No cumple con los criterios de negocio definidos.');
    }
  }

  return resultados;
}

module.exports = { executeSync };