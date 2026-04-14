const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

/**
 * --- UTILIDADES DE NORMALIZACIÓN Y HASH ---
 */
function normalizeHsContactToQb(hsContact, qbParentId) {
  const props = hsContact.properties || {};
  const firstName = props.firstname || "";
  const lastName = props.lastname || "";
  const email = props.email || "";
  
  let displayName = `${firstName} ${lastName}`.trim();
  if (!displayName) displayName = email;

  return {
    email, firstName, lastName,
    phone: props.phone || "",
    mobile: props.hs_whatsapp_phone_number || "",
    address: props.address || "", city: props.city || "",
    state: props.state || "", zip: props.zip || "",
    country: props.country || "", parentRef: qbParentId, displayName
  };
}

function generateHash(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * --- SINCRONIZACIÓN HS -> QB ---
 */
async function processContact(hsContactId, tenantId = DEFAULT_TENANT_ID) {
  logger.info(`[Sync] Procesando Contacto HS ID: ${hsContactId}`, { source: 'HUBSPOT', entity: 'contact', entityId: hsContactId, tenantId });

  const hsContact = await hubspotClient.getContactDetails(hsContactId);
  if (!hsContact || !hsContact.properties?.email) {
    logger.warn(`⚠️ Contacto HS ${hsContactId} sin datos válidos o email. Ignorando.`);
    return null;
  }

  let qbParentId = null;
  const associatedCompanyIds = await hubspotClient.getContactAssociatedCompanyIds(hsContactId);
  if (associatedCompanyIds.length > 0) {
    const hsCompanyId = associatedCompanyIds[0];
    const companyMapping = await mappingService.findByHsId(tenantId, 'company', hsCompanyId);
    if (companyMapping && companyMapping.qbId) qbParentId = companyMapping.qbId;
  }

  const normalizedData = normalizeHsContactToQb(hsContact, qbParentId);
  const newHash = generateHash(normalizedData);
  const mapping = await mappingService.findByHsId(tenantId, 'contact', hsContactId);

  let qbCustomerId = null;

  // CASO A: ACTUALIZACIÓN (Ya existe mapping)
  if (mapping && mapping.qbId) {
    qbCustomerId = mapping.qbId;

    if (mapping.payloadHash === newHash) {
      logger.info(`⏩ Sin cambios reales (Hash coincide). Omitiendo actualización en QB.`, { qbCustomerId });
      return { qbCustomerId };
    }

    logger.info(`📝 Cambios detectados. Actualizando cliente en QB...`);
    echoSuppression.markAsCreatedInQb(qbCustomerId);
    const updated = await quickbooksClient.updateCustomer(qbCustomerId, mapping.qbSyncToken, normalizedData);
    
    await mappingService.upsertMapping({
      tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
      qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
    });

  } else {
    // CASO B: CREACIÓN
    let existingQbCustomer = await quickbooksClient.findCustomerByEmail(normalizedData.email);
    
    if (!existingQbCustomer) {
      existingQbCustomer = await quickbooksClient.findCustomerByDisplayName(normalizedData.displayName);
      if (existingQbCustomer) normalizedData.displayName = `${normalizedData.displayName} (${normalizedData.email})`;
    }

    if (!existingQbCustomer) {
      logger.info(`✨ Contacto no existe en QB. Creando nuevo cliente...`);
      existingQbCustomer = await quickbooksClient.createCustomer(normalizedData);
      echoSuppression.markAsCreatedInQb(existingQbCustomer.Id);
    }

    qbCustomerId = existingQbCustomer.Id;

    await mappingService.upsertMapping({
      tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
      qbSyncToken: existingQbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
    });

    echoSuppression.markAsCreatedInHs(hsContactId);
    await hubspotClient.updateContactProperty(hsContactId, qbCustomerId);
  }

  return { qbCustomerId };
}

/**
 * --- SINCRONIZACIÓN QB -> HS ---
 */
async function syncCustomerFromQuickbooks(qbCustomerId, tenantId = DEFAULT_TENANT_ID) {
  logger.info(`[Sync] Sincronizando Customer QB ID: ${qbCustomerId} hacia HubSpot`, { source: 'QUICKBOOKS', entity: 'contact', entityId: qbCustomerId, tenantId });

  if (echoSuppression.wasCreatedInQb(qbCustomerId)) {
    logger.info(`♻️ [Echo Check] Ignorando cambio en QB ID ${qbCustomerId} (generado internamente).`);
    return;
  }

  const qbCustomer = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
  if (!qbCustomer) return;

  const isSubCustomer = qbCustomer.Job || qbCustomer.IsProject || qbCustomer.ParentRef;
  const isPerson = qbCustomer.GivenName || qbCustomer.FamilyName;

  if (isSubCustomer || isPerson) {
    // --- FLUJO DE CONTACTO ---
    const hsProps = {
      firstname: qbCustomer.GivenName || "", lastname: qbCustomer.FamilyName || "",
      email: qbCustomer.PrimaryEmailAddr?.Address || "", phone: qbCustomer.PrimaryPhone?.FreeFormNumber || "",
      hs_whatsapp_phone_number: qbCustomer.Mobile?.FreeFormNumber || "", address: qbCustomer.BillAddr?.Line1 || "",
      city: qbCustomer.BillAddr?.City || "", state: qbCustomer.BillAddr?.CountrySubDivisionCode || "",
      zip: qbCustomer.BillAddr?.PostalCode || "", country: qbCustomer.BillAddr?.Country || "",
    };

    const newHash = generateHash(hsProps);
    const mapping = await mappingService.findByQbId(tenantId, 'contact', qbCustomerId);
    let hsContactId = mapping ? mapping.hsId : null;

    if (hsContactId) {
      if (mapping.payloadHash === newHash) {
        logger.info(`⏩ Sin cambios reales (Hash coincide). Omitiendo actualización en HS.`);
      } else {
        logger.info(`✅ Contacto HS encontrado. Actualizando...`);
        echoSuppression.markAsCreatedInHs(hsContactId);
        await hubspotClient.updateContact(hsContactId, hsProps);
        await mappingService.upsertMapping({
          tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
          qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
        });
      }
    } else {
      logger.info(`✨ Contacto no mapeado. Buscando/Creando en HS...`);
      let existingHsContact = hsProps.email ? (await hubspotClient.getAllContacts()).find(c => c.properties.email === hsProps.email) : null;
      
      if (existingHsContact) {
        hsContactId = existingHsContact.id;
        await hubspotClient.updateContactProperty(hsContactId, qbCustomerId);
      } else {
        const newContact = await hubspotClient.createSingleContact(hsProps, qbCustomerId);
        hsContactId = newContact.id;
      }

      echoSuppression.markAsCreatedInHs(hsContactId);
      await mappingService.upsertMapping({
        tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
        qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
      });
    }

    // MANEJO DE ASOCIACIÓN (Padre/Hijo)
    if (hsContactId && qbCustomer.ParentRef) {
      const parentMapping = await mappingService.findByQbId(tenantId, 'company', qbCustomer.ParentRef.value);
      if (parentMapping && parentMapping.hsId) {
        const currentAssocs = await hubspotClient.getContactAssociatedCompanyIds(hsContactId);
        if (!currentAssocs.includes(parentMapping.hsId)) {
          for (const oldId of currentAssocs) await hubspotClient.disassociateContactFromCompany(hsContactId, oldId);
          await hubspotClient.associateContactToCompany(hsContactId, parentMapping.hsId);
        }
      }
    }

  } else {
    // --- FLUJO DE EMPRESA ---
    logger.info(`🏢 Identificado como EMPRESA. Delegando al servicio de empresas...`);
    // Aquí invocaremos al company.sync.service cuando lo refactoricemos.
    // Por ahora, simplemente registramos que la lógica lo identificó correctamente.
  }
}

module.exports = { processContact, syncCustomerFromQuickbooks };