const qbClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const logger = require('../lib/logger.lib');

async function executeSync() {
  logger.info('[Sync] Iniciando envío masivo de clientes QB → HubSpot...');
  
  const customers = await qbClient.getAllCustomers();
  
  if (!customers || customers.length === 0) {
    logger.warn('[Sync] No se encontraron clientes en QuickBooks para sincronizar.');
    return null;
  }

  customers.sort((a, b) => {
    if (!a.ParentRef && b.ParentRef) return -1;
    if (a.ParentRef && !b.ParentRef) return 1;
    return 0;
  });

  let resultados = { empresasCreadas: 0, contactosCreados: 0, asociaciones: 0 };

  for (const customer of customers) {
    const qbId = customer.Id; 
    const parentId = customer.ParentRef?.value; 
    const givenName = customer.GivenName || '';
    const familyName = customer.FamilyName || '';
    const email = customer.PrimaryEmailAddr?.Address || '';
    const nombreEmpresa = customer.CompanyName || customer.DisplayName;

    logger.info(`[Sync] Evaluando QB ID [${qbId}]: ${customer.DisplayName}`);

    try {
      if (!parentId && !givenName && !familyName) {
        logger.info(` -> Detectado como EMPRESA PADRE. Verificando en HubSpot...`);
        let hsCompanyId = await hubspotClient.searchCompanyByQbId(qbId);

        if (!hsCompanyId) {
          logger.info(` -> No existe. Creando Empresa en HubSpot...`);
          await hubspotClient.createCompany(nombreEmpresa, qbId);
          resultados.empresasCreadas++;
        } else {
          logger.info(` -> La empresa ya existe (HS ID: ${hsCompanyId}). Omitiendo.`);
        }
      } 
      else if (parentId) {
        logger.info(` -> Detectado como EMPLEADO (Hijo). Pertenece al Padre ID: ${parentId}`);
        
        let hsCompanyId = await hubspotClient.searchCompanyByQbId(parentId);
        
        const hsContact = await hubspotClient.createSingleContact({
          firstname: givenName,
          lastname: familyName,
          email: email
        }, qbId);
        resultados.contactosCreados++;

        if (hsCompanyId && hsContact.id) {
          await hubspotClient.associateContactToCompany(hsContact.id, hsCompanyId);
          resultados.asociaciones++;
          logger.info(' -> Asociación exitosa entre empleado y empresa.');
        } else {
          logger.warn(` -> ALERTA: No se pudo asociar. Empresa Padre [${parentId}] no encontrada en HS.`);
        }
      }
      else if (!parentId && (givenName || familyName)) {
          logger.info(' -> Detectado como CONTACTO INDIVIDUAL. Creando en HubSpot...');
          await hubspotClient.createSingleContact({
            firstname: givenName,
            lastname: familyName,
            email: email
          }, qbId);
          resultados.contactosCreados++;
      } else {
          logger.info(' -> Ignorado: No cumple con los criterios de negocio.');
      }
    } catch (error) {
      logger.error(`❌ Error sincronizando customer QB ${qbId}:`, error);
    }
  }

  return resultados;
}

module.exports = { executeSync };