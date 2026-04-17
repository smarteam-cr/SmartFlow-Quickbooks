const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const companySyncService = require('./company.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');

function normalizeHsContactToQb(hsContact, qbParentId) {
  const props = hsContact.properties || {};
  const email = props.email || "";
  let displayName = `${props.firstname || ""} ${props.lastname || ""}`.trim();
  if (!displayName) displayName = email;

  return {
    email, firstName: props.firstname || "", lastName: props.lastname || "",
    phone: props.phone || "", mobile: props.hs_whatsapp_phone_number || "",
    address: props.address || "", city: props.city || "",
    state: props.state || "", zip: props.zip || "",
    country: props.country || "", parentRef: qbParentId, displayName
  };
}

function generateHash(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * --- HS -> QB ---
 */
async function processContact(hsContactId, tenantId = DEFAULT_TENANT_ID) {
  if (echoSuppression.wasCreatedInHs(hsContactId)) {
    logger.info(`♻️ [Echo Check] Ignorando evento de Contacto HS ID ${hsContactId} (generado internamente).`);
    return null;
  }

  logger.info(`[Sync] Procesando Contacto HS ID: ${hsContactId}`, { source: 'HUBSPOT', entity: 'contact', entityId: hsContactId, tenantId });

  let hsContact;
  try {
    hsContact = await hubspotClient.getContactDetails(hsContactId);
  } catch (error) {
    logger.error(`❌ Error al obtener detalles del Contacto HS ID ${hsContactId}: ${error.message}`, { hsContactId, error: error.message });
    return null;
  }
  if (!hsContact || !hsContact.properties?.email) return null;

  try {
    let qbParentId = null;
    const associatedCompanyIds = await hubspotClient.getContactAssociatedCompanyIds(hsContactId);
    if (associatedCompanyIds.length > 0) {
      const companyMapping = await mappingService.findByHsId(tenantId, 'company', associatedCompanyIds[0]);
      if (companyMapping && companyMapping.qbId) qbParentId = companyMapping.qbId;
    }

    const normalizedData = normalizeHsContactToQb(hsContact, qbParentId);
    const newHash = generateHash(normalizedData);
    const mapping = await mappingService.findByHsId(tenantId, 'contact', hsContactId);
    let qbCustomerId = null;

    if (mapping && mapping.qbId) {
      qbCustomerId = mapping.qbId;
      if (mapping.payloadHash === newHash) {
        logger.info(`⏩ Sin cambios reales (Hash coincide). Omitiendo actualización en QB.`);
        return { qbCustomerId };
      }

      logger.info(`📝 Cambios detectados. Actualizando cliente en QB...`);

      const currentQbData = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
      if (!currentQbData) {
        logger.warn(`⚠️ Cliente QB ${qbCustomerId} no encontrado (Borrado). No se puede actualizar.`);
        return { qbCustomerId };
      }

      echoSuppression.markAsCreatedInQb(qbCustomerId);
      const updated = await quickbooksClient.updateCustomer(qbCustomerId, currentQbData.SyncToken, normalizedData);

      await mappingService.upsertMapping({
        tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
        qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
      });
    } else {
      let existingQbCustomer = await quickbooksClient.findCustomerByEmail(normalizedData.email);
      if (!existingQbCustomer) {
        existingQbCustomer = await quickbooksClient.findCustomerByDisplayName(normalizedData.displayName);
        if (existingQbCustomer) normalizedData.displayName = `${normalizedData.displayName} (${normalizedData.email})`;
      }

      if (!existingQbCustomer) {
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
  } catch (error) {
    logger.error(`❌ Error en processContact para HS ID ${hsContactId}: ${error.message}`, {
      hsContactId, tenantId, error: error.message, stack: error.stack
    });
    throw error;
  }
}

/**
 * --- QB -> HS ---
 */
async function syncCustomerFromQuickbooks(qbCustomerId, tenantId = DEFAULT_TENANT_ID) {
  logger.info(`[Sync] Evaluando Customer QB ID: ${qbCustomerId}`, { source: 'QUICKBOOKS', entity: 'contact', entityId: qbCustomerId, tenantId });

  if (echoSuppression.wasCreatedInQb(qbCustomerId)) return;

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

    const newHash = generateHash({ ...hsProps, _parentRef: qbCustomer.ParentRef?.value || null });
    const mapping = await mappingService.findByQbId(tenantId, 'contact', qbCustomerId);
    let hsContactId = mapping ? mapping.hsId : null;

    if (hsContactId) {
      if (mapping.payloadHash === newHash) {
        logger.info(`⏩ Sin cambios reales (Hash coincide). Omitiendo actualización en HS.`);
      } else {
        echoSuppression.markAsCreatedInHs(hsContactId);
        await hubspotClient.updateContact(hsContactId, hsProps);
        await mappingService.upsertMapping({
          tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
          qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
        });
      }
    } else {
      let existingHsContact = hsProps.email ? await hubspotClient.searchContactByEmail(hsProps.email) : null;
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

    if (hsContactId && qbCustomer.ParentRef) {
      // Sub-customer → Asociar contacto a la empresa padre en HS
      const parentMapping = await mappingService.findByQbId(tenantId, 'company', qbCustomer.ParentRef.value);
      if (parentMapping && parentMapping.hsId) {
        const currentAssocs = await hubspotClient.getContactAssociatedCompanyIds(hsContactId);
        if (!currentAssocs.includes(parentMapping.hsId)) {
          for (const oldId of currentAssocs) await hubspotClient.disassociateContactFromCompany(hsContactId, oldId);
          await hubspotClient.associateContactToCompany(hsContactId, parentMapping.hsId);
          logger.info(`🔗 Contacto HS ${hsContactId} asociado a Empresa HS ${parentMapping.hsId}`);
        }
      }
    } else if (hsContactId && !qbCustomer.ParentRef) {
      // Ya NO es sub-customer → Desasociar de cualquier empresa en HS
      const currentAssocs = await hubspotClient.getContactAssociatedCompanyIds(hsContactId);
      if (currentAssocs.length > 0) {
        logger.info(`🔓 Contacto QB ${qbCustomerId} dejó de ser sub-customer. Desasociando de ${currentAssocs.length} empresa(s) en HS...`);
        for (const companyId of currentAssocs) {
          await hubspotClient.disassociateContactFromCompany(hsContactId, companyId);
          logger.info(`  ↳ Desasociado de Empresa HS ${companyId}`);
        }
      }
    }
  } else {
    // --- FLUJO DE EMPRESA ---
    logger.info(`🏢 Identificado como EMPRESA. Ejecutando servicio de empresas...`);
    // 🔗 FIX: Llamamos al servicio de empresas y le pasamos el control
    await companySyncService.syncCompanyFromQuickbooks(qbCustomerId, tenantId);
  }
}

module.exports = { processContact, syncCustomerFromQuickbooks };