const hubspotClient = require("../integrations/hubspot/hubspot.client");
const quickbooksClient = require("../integrations/quickbooks/quickbooks.client");
const echoSuppression = require("../utils/echo.suppression.util");
const mutex = require('../utils/mutex.util');
const logger = require('../lib/logger.lib');

async function _internalProcessContact(contactId) {
  logger.info(`[Sync] Procesando Contacto HS ID: ${contactId}`, { source: 'HUBSPOT', entity: 'contact', entityId: contactId });

  try {
    // 1. Obtenemos datos de HubSpot
    const contactData = await hubspotClient.getContactDetails(contactId);

    if (!contactData) {
      logger.info(`❌ Saltando el contacto ${contactId} porque no existen datos válidos.`);
      return null;
    }

    const {
      email,
      firstname: firstName,
      lastname: lastName,
      phone,
      hs_whatsapp_phone_number,
      address,
      city,
      state,
      zip,
      country,
    } = contactData.properties;

    const id_usuario_quickbooks = contactData.properties.id_usuario_quickbooks;

    if (!email) {
      logger.warn(`⚠️ El contacto de HubSpot ${contactId} no tiene email. Ignorando sincronización.`);
      return null;
    }

    // 2. Resolver Asociación con Empresa (ParentRef)
    let qbParentId = null;
    const associatedCompanyIds = await hubspotClient.getContactAssociatedCompanyIds(contactId);

    if (associatedCompanyIds.length > 0) {
      const hsCompanyId = associatedCompanyIds[0];
      logger.info(`🏢 Contacto asociado a Empresa HS ID: ${hsCompanyId}. Resolviendo en QB...`);

      const companySyncService = require("./company.sync.service");
      await companySyncService.processCompany(hsCompanyId);

      const companyData = await hubspotClient.getCompanyDetails(hsCompanyId);
      if (companyData && companyData.properties.id_usuario_quickbooks) {
        qbParentId = companyData.properties.id_usuario_quickbooks;
        logger.info(`✅ Empresa vinculada en QB con ID: ${qbParentId}`);
      }
    }

    // 3. Lógica de Sincronización (Creación o Actualización)
    let qbCustomerId = null;
    let existingCustomer = null;

    // Intentamos localizar por el ID guardado o por email
    if (id_usuario_quickbooks) {
      existingCustomer = await quickbooksClient.getCustomerById(id_usuario_quickbooks).catch(() => null);
      
      // 🛡️ AUTO-SANACIÓN: Si el cliente está inactivo (borrado en QB), lo ignoramos para forzar re-creación/vínculo
      if (existingCustomer && existingCustomer.Active === false) {
        logger.warn(`⚠️ El cliente QB ID ${id_usuario_quickbooks} está inactivo/borrado. Forzando re-sincronización.`);
        existingCustomer = null;
      }
    }

    if (!existingCustomer) {
      existingCustomer = await quickbooksClient.findCustomerByEmail(email);
    }

    const customerData = {
      email,
      firstName,
      lastName,
      phone,
      mobile: hs_whatsapp_phone_number,
      address,
      city,
      state,
      zip,
      country,
      parentRef: qbParentId,
      hsId: contactId
    };

    if (existingCustomer) {
      // === CASO A: ACTUALIZACIÓN ===
      qbCustomerId = existingCustomer.Id;
      const qbSyncToken = existingCustomer.SyncToken;

      logger.info(`🔄 Cliente ENCONTRADO (QB ID: ${qbCustomerId}). Validando cambios reales...`);

      // 1. COMPARACIÓN DE ESTADO (Deep Compare de HS a QB)
      const hasRealChanges = 
          (customerData.email !== (existingCustomer.PrimaryEmailAddr?.Address || "")) ||
          (customerData.firstName !== (existingCustomer.GivenName || "")) ||
          (customerData.lastName !== (existingCustomer.FamilyName || "")) ||
          (customerData.phone !== (existingCustomer.PrimaryPhone?.FreeFormNumber || "")) ||
          (customerData.mobile !== (existingCustomer.Mobile?.FreeFormNumber || "")) ||
          (customerData.address !== (existingCustomer.BillAddr?.Line1 || "")) ||
          (customerData.city !== (existingCustomer.BillAddr?.City || "")) ||
          (customerData.state !== (existingCustomer.BillAddr?.CountrySubDivisionCode || "")) ||
          (customerData.zip !== (existingCustomer.BillAddr?.PostalCode || "")) ||
          (customerData.country !== (existingCustomer.BillAddr?.Country || "")) ||
          (customerData.parentRef !== (existingCustomer.ParentRef?.value || null));

      if (!hasRealChanges) {
          logger.info(`⏩ Sin cambios reales detectados. Omitiendo actualización en QuickBooks (ECO).`);
      } else {
          logger.info(`📝 Cambios detectados. Sincronizando hacia QuickBooks...`);
          echoSuppression.markAsCreatedInQb(qbCustomerId);
          const updatedCustomer = await quickbooksClient.updateCustomer(qbCustomerId, qbSyncToken, customerData);
          qbCustomerId = updatedCustomer.Id;
      }
    } else {
      // === CASO B: CREACIÓN ===
      const baseDisplayName = `${firstName || ""} ${lastName || ""}`.trim();
      let finalDisplayName = baseDisplayName || email;

      logger.info(`✨ Contacto no existe en QB. Verificando disponibilidad de nombre: "${finalDisplayName}"...`);
      const qbCustomerByName = await quickbooksClient.findCustomerByDisplayName(finalDisplayName);

      if (qbCustomerByName) {
        finalDisplayName = `${finalDisplayName} (${email})`;
        logger.warn(`⚠️ Nombre duplicado. Ajustando DisplayName a: "${finalDisplayName}"`);
      }

      const newQbCustomer = await quickbooksClient.createCustomer({
        ...customerData,
        displayName: finalDisplayName
      });
      qbCustomerId = newQbCustomer.Id;
      echoSuppression.markAsCreatedInQb(qbCustomerId);
      logger.info(`✅ Cliente CREADO en QB (ID: ${qbCustomerId})`);
    }

    // 4. Actualizamos el ID en HubSpot (con supresión de eco)
    if (!id_usuario_quickbooks || id_usuario_quickbooks !== qbCustomerId.toString()) {
      logger.info(`🔗 Enlazando ID de QuickBooks ${qbCustomerId} en HubSpot...`);
      echoSuppression.markAsCreatedInHs(contactId);
      await hubspotClient.updateContactProperty(contactId, qbCustomerId);
    }

    const contactInfo = {
      displayName: existingCustomer ? existingCustomer.DisplayName : (customerData.displayName || `${firstName || ""} ${lastName || ""}`.trim()),
      address,
      city,
      state,
      zip,
      country
    };

    return { qbCustomerId, contactInfo };
  } catch (error) {
    logger.error(`❌ Error procesando contacto HS ${contactId}:`, error);
    throw error;
  }
}

// Esta es la función que exportas y que todos llamarán
async function processContact(contactId) {
  return await _internalProcessContact(contactId);
}

/**
 * --- SINCRONIZACIÓN QB -> HS ---
 * Procesa un webhook de cambio en un Customer de QuickBooks y lo lleva a HubSpot.
 */
async function _internalSyncCustomerFromQuickbooks(qbCustomerId) {
  logger.info(`[Sync] Sincronizando Customer QB ID: ${qbCustomerId} hacia HubSpot`, { source: 'QUICKBOOKS', entity: 'contact', entityId: qbCustomerId });

  // 1. Supresión de Eco: Si lo acabamos de crear nosotros en QB, lo ignoramos
  if (echoSuppression.wasCreatedInQb(qbCustomerId)) {
    logger.info(`♻️ [Echo Check] Ignorando cambio en QB ID ${qbCustomerId} porque fue generado internamente.`);
    return;
  }

  try {
    // 2. Obtener datos de QuickBooks
    const qbCustomer = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
    if (!qbCustomer) {
      logger.error(`❌ No se encontró el Customer ${qbCustomerId} en QuickBooks.`);
      return;
    }

    // 3. Determinar si es Contacto o Empresa en HS
    const isSubCustomer = qbCustomer.Job || qbCustomer.IsProject || qbCustomer.ParentRef;
    const isPerson = qbCustomer.GivenName || qbCustomer.FamilyName;

    // Mapeo básico de campos
    const mappedProperties = {
      firstname: qbCustomer.GivenName || "",
      lastname: qbCustomer.FamilyName || "",
      email: qbCustomer.PrimaryEmailAddr?.Address || "",
      phone: qbCustomer.PrimaryPhone?.FreeFormNumber || "",
      hs_whatsapp_phone_number: qbCustomer.Mobile?.FreeFormNumber || "",
      address: qbCustomer.BillAddr?.Line1 || "",
      city: qbCustomer.BillAddr?.City || "",
      state: qbCustomer.BillAddr?.CountrySubDivisionCode || "",
      zip: qbCustomer.BillAddr?.PostalCode || "",
      country: qbCustomer.BillAddr?.Country || "",
    };

    // 4. Lógica de Sincronización (QB -> HS)
    if (isSubCustomer || isPerson) {
      // === FLUJO DE CONTACTO ===
      logger.info(`👤 Identificado como CONTACTO. Buscando en HS...`);
      let hsContact = await hubspotClient.searchContactByQbId(qbCustomerId);
      let foundByEmail = false;

      if (!hsContact && mappedProperties.email) {
        logger.info(`🔍 No encontrado por ID. Buscando por email: ${mappedProperties.email}`);
        const allContacts = await hubspotClient.getAllContacts();
        hsContact = allContacts.find(c => c.properties.email === mappedProperties.email);
        if(hsContact) foundByEmail = true;
      }

      if (hsContact) {
        // 1. COMPARACIÓN DE ESTADO (Deep Compare)
        let hasRealChanges = false;
        for (const key of Object.keys(mappedProperties)) {
          if (mappedProperties[key] !== undefined && mappedProperties[key] !== hsContact.properties[key]) {
            hasRealChanges = true;
            break;
          }
        }

        if (!hasRealChanges) {
          logger.info(`⏩ Sin cambios reales en propiedades. Omitiendo actualización en HS (prevención de eco tardío).`);
        } else {
          logger.info(`✅ Contacto HS encontrado (ID: ${hsContact.id}). Actualizando...`);
          echoSuppression.markAsCreatedInHs(hsContact.id);
          await hubspotClient.updateContact(hsContact.id, mappedProperties);
        }
        
        if(foundByEmail) {
          logger.info(`🔗 Vinculando QB ID ${qbCustomerId} al contacto HS encontrado por email...`);
          await hubspotClient.updateContactProperty(hsContact.id, qbCustomerId);
        }

      } else if (mappedProperties.email) {
        // ✨ CREACIÓN DE CONTACTO (Si no existe y tiene email)
        logger.info(`✨ Contacto no existe en HS. Creando...`);
        const newContact = await hubspotClient.createSingleContact(mappedProperties, qbCustomerId);
        logger.info(`✅ Contacto CREADO en HS (ID: ${newContact.id})`);
        echoSuppression.markAsCreatedInHs(newContact.id); // 🌟 PREVENIR ECO

        hsContact = newContact;
      }

      // === MANEJO DE ASOCIACIÓN (JERARQUÍA / SUB-CUSTOMER) ===
      if (hsContact) {
        const currentAssocs = await hubspotClient.getContactAssociatedCompanyIds(hsContact.id);

        if (qbCustomer.ParentRef) {
          // Caso A: Tiene un ParentRef en QuickBooks
          const parentQbId = qbCustomer.ParentRef.value;
          const hsCompanyId = await hubspotClient.searchCompanyByQbId(parentQbId);

          if (hsCompanyId) {
            if (!currentAssocs.includes(hsCompanyId)) {
              logger.info(`🔗 Vinculando Contacto a Empresa HS ID: ${hsCompanyId}...`);
              for (const oldId of currentAssocs) {
                await hubspotClient.disassociateContactFromCompany(hsContact.id, oldId);
              }
              await hubspotClient.associateContactToCompany(hsContact.id, hsCompanyId);
            }
          }
        } else {
          // Caso B: Ya no es Sub-Customer en QuickBooks
          if (currentAssocs && currentAssocs.length > 0) {
            logger.info(`🔗 El cliente ya no es Sub-Customer en QB. Removiendo asociaciones en HS...`);
            for (const oldId of currentAssocs) {
              await hubspotClient.disassociateContactFromCompany(hsContact.id, oldId);
            }
          }
        }
      }

    } else {
      // === FLUJO DE EMPRESA ===
      logger.info(`🏢 Identificado como EMPRESA. Buscando en HS...`);
      let hsCompanyId = await hubspotClient.searchCompanyByQbId(qbCustomerId);

      const companyProps = {
        name: qbCustomer.CompanyName || qbCustomer.DisplayName,
        nit: qbCustomer.AlternatePhone?.FreeFormNumber || "",
        phone: qbCustomer.PrimaryPhone?.FreeFormNumber || "",
        domain: (qbCustomer.WebAddr?.URI || "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase(),
        address: qbCustomer.BillAddr?.Line1 || "",
        city: qbCustomer.BillAddr?.City || "",
        state: qbCustomer.BillAddr?.CountrySubDivisionCode || "",
        zip: qbCustomer.BillAddr?.PostalCode || "",
        country: qbCustomer.BillAddr?.Country || "",
        id_usuario_quickbooks: qbCustomerId.toString()
      };

      if (hsCompanyId) {
        logger.info(`✅ Empresa HS encontrada (ID: ${hsCompanyId}). Validando cambios reales...`);
        
        const hsCompany = await hubspotClient.getCompanyDetails(hsCompanyId);
        
        if (hsCompany) {
          let hasRealChanges = false;
          for (const key of Object.keys(companyProps)) {
            let val1 = companyProps[key] || "";
            let val2 = hsCompany.properties[key] || "";
            
            if (key === 'domain') {
              val1 = val1.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
              val2 = val2.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
            }

            if (val1 !== val2) {
              hasRealChanges = true;
              logger.info(`🔍 Cambio detectado en ${key}: "${val2}" -> "${val1}"`);
              break;
            }
          }

          if (!hasRealChanges) {
            logger.info(`⏩ Sin cambios reales en propiedades de empresa. Omitiendo actualización en HubSpot (ECO).`);
            return;
          }
        }

        logger.info(`📝 Cambios detectados en empresa QB. Sincronizando hacia HubSpot...`);
        echoSuppression.markAsCreatedInHs(hsCompanyId);
        await hubspotClient.updateCompany(hsCompanyId, companyProps);
      } else {
        // ✨ CREACIÓN DE EMPRESA
        logger.info(`✨ Empresa no existe en HS. Creando con toda la información de QB...`);
        const newCompany = await hubspotClient.createCompany(companyProps);
        logger.info(`✅ Empresa CREADA en HS (ID: ${newCompany.id})`);
        echoSuppression.markAsCreatedInHs(newCompany.id);
      }
    }
  } catch (error) {
    logger.error(`❌ Error sincronizando Customer QB ${qbCustomerId} hacia HubSpot:`, error);
  }
}
async function syncCustomerFromQuickbooks(qbCustomerId) {
  return await _internalSyncCustomerFromQuickbooks(qbCustomerId);
}

module.exports = {
  processContact,
  syncCustomerFromQuickbooks
}