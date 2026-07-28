const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const companySyncService = require('./company.sync.service');
const echoSuppression = require('../utils/echo.suppression.util');
const { capitalizeTitleCase } = require('../utils/text.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID, CONTACT_STATUS_PROPERTY, CONTACT_STATUS_VALUES } = require('../config/constants');
const { InactiveParentError, MissingIdentityError } = require('../utils/errors.util');

/**
 * Normaliza el campo de estado. Vacío/null/inválido se interpreta como 'active'.
 * Solo se considera 'inactive' si el valor es exactamente 'inactive'.
 */
function normalizeHsStatus(rawValue) {
  return rawValue === CONTACT_STATUS_VALUES.INACTIVE
    ? CONTACT_STATUS_VALUES.INACTIVE
    : CONTACT_STATUS_VALUES.ACTIVE;
}

function statusToQbActive(status) {
  return status !== CONTACT_STATUS_VALUES.INACTIVE;
}

function qbActiveToStatus(active) {
  return active === false ? CONTACT_STATUS_VALUES.INACTIVE : CONTACT_STATUS_VALUES.ACTIVE;
}

function normalizeHsContactToQb(hsContact, qbParentId) {
  const props = hsContact.properties || {};
  const suffix = (props.documento_de_identidad || "").substring(0, 16);
  const firstName = capitalizeTitleCase(props.firstname);
  const lastName = capitalizeTitleCase(props.lastname);
  let displayName = `${firstName} ${lastName}`.trim();
  if (suffix) displayName = displayName ? `${displayName} ${suffix}` : suffix;

  const status = normalizeHsStatus(props[CONTACT_STATUS_PROPERTY]);

  return {
    email: props.email || "", firstName, lastName,
    suffix, phone: props.phone || "", mobile: props.hs_whatsapp_phone_number || "",
    address: props.address || "", city: props.city || "",
    state: props.state || "", zip: props.zip || "",
    country: props.country || "", parentRef: qbParentId, displayName,
    status, active: statusToQbActive(status),
    preferredCurrency: props.moneda_de_preferencia || "",
  };
}

function generateHash(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

/**
 * QB exige que un sub-cliente tenga la misma CurrencyRef que su padre
 * (error 6000). Como CurrencyRef es inmutable una vez creado el cliente,
 * detectamos el mismatch ANTES de enviar el payload para evitar el crash
 * y el retry loop. Si las monedas difieren, se omite el ParentRef: el
 * contacto queda como cliente independiente en QB y la asociación en HS
 * se preserva.
 *
 * Devuelve { compatible: true } cuando alguna moneda no está definida —
 * dejamos que QB decida (o use home currency).
 */
async function checkParentCurrencyCompatibility(parentQbId, contactCurrency) {
  if (!parentQbId || !contactCurrency) return { compatible: true };
  const parentQb = await quickbooksClient.getCustomerById(parentQbId).catch(() => null);
  const parentCurrency = parentQb?.CurrencyRef?.value || "";
  if (!parentCurrency) return { compatible: true };
  return {
    compatible: parentCurrency === contactCurrency,
    parentCurrency,
    contactCurrency,
  };
}

const _contactLocks = new Map();

/**
 * --- HS -> QB ---
 * Wrapper con mutex por contactId para evitar race conditions cuando dos jobs
 * concurrentes procesan el mismo contacto que aún no existe en QB.
 */
async function processContact(hsContactId, tenantId = DEFAULT_TENANT_ID) {
  const lockKey = `${tenantId}:${hsContactId}`;

  if (_contactLocks.has(lockKey)) {
    logger.info(`⏳ [Lock] Esperando proceso en curso para Contacto HS ${hsContactId}...`);
    try {
      // Reutilizamos el resultado del proceso en curso para heredar contactInfo,
      // status y cualquier otro campo que retorne _doProcessContact. Antes aquí
      // se retornaba solo { qbCustomerId }, lo que dejaba sin contactInfo a los
      // callers aguas abajo (ej. invoice sync) y rompía validaciones como la de
      // moneda (preferredCurrency llegaba undefined → "").
      return await _contactLocks.get(lockKey);
    } catch (err) {
      // Si el proceso original falló, fallback al mapping existente (comportamiento heredado).
      const existing = await mappingService.findByHsId(tenantId, 'contact', hsContactId);
      if (existing?.qbId) return { qbCustomerId: existing.qbId };
      return null;
    }
  }

  const execution = _doProcessContact(hsContactId, tenantId);
  _contactLocks.set(lockKey, execution);
  try {
    return await execution;
  } finally {
    _contactLocks.delete(lockKey);
  }
}

async function _doProcessContact(hsContactId, tenantId = DEFAULT_TENANT_ID) {
  if (echoSuppression.wasCreatedInHs(hsContactId)) {
    logger.info(`♻️ [Echo Check] Ignorando evento de Contacto HS ID ${hsContactId} (generado internamente).`);
    const existingMapping = await mappingService.findByHsId(tenantId, 'contact', hsContactId);
    if (existingMapping?.qbId) return { qbCustomerId: existingMapping.qbId };
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
  if (!hsContact) return null;
  if (!hsContact.properties?.documento_de_identidad) {
    throw new MissingIdentityError(`Contacto HS ${hsContactId} sin documento_de_identidad. Se omite el sync con QuickBooks.`);
  }

  try {
    let qbParentId = null;
    const associatedCompanyIds = await hubspotClient.getContactAssociatedCompanyIds(hsContactId);
    if (associatedCompanyIds.length > 0) {
      const companyMapping = await mappingService.findByHsId(tenantId, 'company', associatedCompanyIds[0]);
      if (companyMapping && companyMapping.qbId) qbParentId = companyMapping.qbId;
    }

    const normalizedData = normalizeHsContactToQb(hsContact, qbParentId);
    let newHash = generateHash(normalizedData);
    const mapping = await mappingService.findByHsId(tenantId, 'contact', hsContactId);
    let qbCustomerId = null;

    if (mapping && mapping.qbId) {
      qbCustomerId = mapping.qbId;
      if (mapping.payloadHash === newHash) {
        logger.info(`⏩ Sin cambios reales (Hash coincide). Omitiendo actualización en QB.`);
        return { qbCustomerId, contactInfo: normalizedData, status: normalizedData.status };
      }

      logger.info(`📝 Cambios detectados. Actualizando cliente en QB...`);

      const currentQbData = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
      if (!currentQbData) {
        logger.warn(`⚠️ Cliente QB ${qbCustomerId} no encontrado (Borrado). No se puede actualizar.`);
        return { qbCustomerId };
      }

      // Pre-validación: si vamos a ACTIVAR un sub-customer, el padre debe estar activo en QB.
      // QB rechaza la activación de un hijo con padre inactivo (HTTP 400).
      const isActivating = normalizedData.active === true && currentQbData.Active === false;
      const parentRef = currentQbData.ParentRef?.value;
      if (isActivating && parentRef) {
        const parentQb = await quickbooksClient.getCustomerById(parentRef).catch(() => null);
        if (parentQb && parentQb.Active === false) {
          logger.warn(`🛑 Contacto HS ${hsContactId} intenta activarse pero el padre QB ${parentRef} está inactivo. Revirtiendo HS a 'inactive'.`);
          echoSuppression.markAsCreatedInHs(hsContactId);
          await hubspotClient.updateContact(hsContactId, { [CONTACT_STATUS_PROPERTY]: CONTACT_STATUS_VALUES.INACTIVE }).catch(err => {
            logger.warn(`No se pudo revertir el estado del contacto HS ${hsContactId}: ${err.message}`);
          });
          throw new InactiveParentError(`No se puede activar el contacto HS ${hsContactId}: la empresa padre QB ${parentRef} está inactiva. Activa primero la empresa.`);
        }
      }

      // Drift de moneda: QB no permite cambiar CurrencyRef en un customer existente.
      // Si HS tiene una moneda distinta a la de QB, QB es la verdad inmutable:
      // revertimos HS para que refleje QB. Previene que las validaciones de
      // factura (HS-vs-HS) pasen con datos desincronizados y produzcan facturas
      // en la moneda incorrecta.
      const hsCurrency = normalizedData.preferredCurrency || "";
      const qbCurrency = currentQbData.CurrencyRef?.value || "";
      if (hsCurrency !== qbCurrency) {
        if (qbCurrency) {
          logger.warn(`⚠️ Drift de moneda en contacto HS ${hsContactId}: moneda_de_preferencia="${hsCurrency}" pero QB ${qbCustomerId} tiene CurrencyRef="${qbCurrency}" (inmutable). Re-alineando HS a "${qbCurrency}".`);
          echoSuppression.markAsCreatedInHs(hsContactId);
          await hubspotClient.updateContact(hsContactId, { moneda_de_preferencia: qbCurrency }).catch(err => {
            logger.warn(`No se pudo revertir moneda_de_preferencia en HS ${hsContactId}: ${err.message}`);
          });
          // Reflejar el estado final en normalizedData y recomputar hash para
          // que el mapping guarde el estado alineado (evita loops de hash-mismatch).
          normalizedData.preferredCurrency = qbCurrency;
          newHash = generateHash(normalizedData);
        } else {
          logger.warn(`⚠️ QB customer ${qbCustomerId} sin CurrencyRef. HS tiene moneda_de_preferencia="${hsCurrency}". No se modifica HS.`);
        }
      }

      // Pre-chequeo de moneda del padre: QB rechaza sub-customers cuya
      // CurrencyRef difiere del padre. Solo chequeamos si estamos cambiando
      // el padre (evita warnings espurios y una llamada API innecesaria
      // cuando el parent no cambia).
      if (normalizedData.parentRef && normalizedData.parentRef !== currentQbData.ParentRef?.value) {
        const contactQbCurrency = currentQbData.CurrencyRef?.value || "";
        const check = await checkParentCurrencyCompatibility(normalizedData.parentRef, contactQbCurrency);
        if (!check.compatible) {
          logger.warn(
            `⚠️ Moneda incompatible al asignar padre para contacto HS ${hsContactId}: contacto QB ${qbCustomerId}=${check.contactCurrency} vs padre QB ${normalizedData.parentRef}=${check.parentCurrency}. Se omite ParentRef en QB. La asociación en HS se preserva. Corrección requiere acción manual en QB (CurrencyRef es inmutable).`
          );
          normalizedData.parentRef = undefined;
        }
      }

      echoSuppression.markAsCreatedInQb(qbCustomerId);
      const updated = await quickbooksClient.updateCustomer(qbCustomerId, currentQbData.SyncToken, normalizedData);

      await mappingService.upsertMapping({
        tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
        qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
      });
    } else {
      // Dedup primario por cédula (Suffix): la identidad es el documento,
      // no el nombre. Evita duplicados cuando el nombre difiere ligeramente
      // entre HS y QB pero se trata del mismo humano.
      let existingQbCustomer = await quickbooksClient.findCustomerBySuffix(normalizedData.suffix);

      if (!existingQbCustomer) {
        // Mismo pre-chequeo que en el UPDATE: si la moneda del contacto
        // nuevo difiere de la del padre, omitimos ParentRef para evitar
        // el rechazo de QB (error 6000). El contacto se crea como cliente
        // independiente; la asociación en HS se mantiene.
        if (normalizedData.parentRef) {
          const check = await checkParentCurrencyCompatibility(normalizedData.parentRef, normalizedData.preferredCurrency);
          if (!check.compatible) {
            logger.warn(
              `⚠️ Moneda incompatible al crear contacto HS ${hsContactId} como sub-cliente: moneda intencion=${check.contactCurrency} vs padre QB ${normalizedData.parentRef}=${check.parentCurrency}. Creando como cliente independiente en QB. La asociación en HS se preserva.`
            );
            normalizedData.parentRef = undefined;
          }
        }
        existingQbCustomer = await quickbooksClient.createCustomer(normalizedData);
        echoSuppression.markAsCreatedInQb(existingQbCustomer.Id);
      }
      qbCustomerId = existingQbCustomer.Id;

      // Backfill de moneda al crear: si HS no traía moneda_de_preferencia,
      // copiar la que QB le asignó (home currency cuando no se mandó
      // CurrencyRef, o la del customer pre-existente cuando vino por
      // findCustomerBySuffix). CurrencyRef en QB es inmutable, así que este
      // es el único momento limpio para alinear HS sin pelear con el drift
      // check del UPDATE. Sin esto, la primera factura del contacto fallaría
      // la validación de moneda (capa 1) por preferredCurrency vacío.
      const hsBackfill = { id_usuario_quickbooks: String(qbCustomerId) };
      const qbCurrency = existingQbCustomer.CurrencyRef?.value || "";
      if (!normalizedData.preferredCurrency && qbCurrency) {
        hsBackfill.moneda_de_preferencia = qbCurrency;
        normalizedData.preferredCurrency = qbCurrency;
        newHash = generateHash(normalizedData);
        logger.info(`💱 Backfill de moneda en HS ${hsContactId}: "${qbCurrency}" (heredada de QB ${qbCustomerId}).`);
      } else if (!normalizedData.preferredCurrency && !qbCurrency) {
        logger.warn(`⚠️ Contacto HS ${hsContactId} sin moneda_de_preferencia y QB ${qbCustomerId} sin CurrencyRef. Las facturas de este contacto van a fallar la validación de moneda hasta rellenar el campo.`);
      }

      await mappingService.upsertMapping({
        tenantId, entityType: 'contact', hsId: hsContactId, qbId: qbCustomerId,
        qbSyncToken: existingQbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
      });
      echoSuppression.markAsCreatedInHs(hsContactId);
      await hubspotClient.updateContact(hsContactId, hsBackfill);
    }
    return { qbCustomerId, contactInfo: normalizedData, status: normalizedData.status };
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
      firstname: capitalizeTitleCase(qbCustomer.GivenName), lastname: capitalizeTitleCase(qbCustomer.FamilyName),
      email: qbCustomer.PrimaryEmailAddr?.Address || "", phone: qbCustomer.PrimaryPhone?.FreeFormNumber || "",
      hs_whatsapp_phone_number: qbCustomer.Mobile?.FreeFormNumber || "", address: qbCustomer.BillAddr?.Line1 || "",
      city: qbCustomer.BillAddr?.City || "", state: qbCustomer.BillAddr?.CountrySubDivisionCode || "",
      zip: qbCustomer.BillAddr?.PostalCode || "", country: qbCustomer.BillAddr?.Country || "",
      documento_de_identidad: qbCustomer.Suffix || "",
      moneda_de_preferencia: qbCustomer.CurrencyRef?.value || "",
      [CONTACT_STATUS_PROPERTY]: qbActiveToStatus(qbCustomer.Active),
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
      const idNumber = qbCustomer.Suffix || "";
      if (!idNumber) {
        logger.warn(`⚠️ Customer QB ${qbCustomerId} sin Suffix (documento_de_identidad). Omitiendo sync a HS.`);
        return;
      }
      let existingHsContact = await hubspotClient.searchContactByIdentification(idNumber);
      if (existingHsContact) {
        // Protección: si el HS contact con esta cédula YA está linkeado a otro
        // QB customer, abortamos. El primer link gana; el duplicado en QB queda
        // huérfano a propósito (debe resolverlo un humano en QB).
        const existingHsMapping = await mappingService.findByHsId(tenantId, 'contact', existingHsContact.id);
        if (existingHsMapping && existingHsMapping.qbId !== String(qbCustomerId)) {
          logger.warn(`🛑 Duplicado de cédula "${idNumber}" en QB. HS contact ${existingHsContact.id} ya está linkeado a QB ${existingHsMapping.qbId}. Se ignora el sync del QB ${qbCustomerId} a HS.`);
          return;
        }
        hsContactId = existingHsContact.id;
        echoSuppression.markAsCreatedInHs(hsContactId);
        await hubspotClient.updateContactProperty(hsContactId, qbCustomerId);
        await hubspotClient.updateContact(hsContactId, hsProps);
      } else {
        const newContact = await hubspotClient.createSingleContact(hsProps, qbCustomerId);
        hsContactId = newContact.id;
        echoSuppression.markAsCreatedInHs(hsContactId);
      }
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