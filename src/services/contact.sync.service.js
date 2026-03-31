const hubspotClient = require("../integrations/hubspot/hubspot.client");
const quickbooksClient = require("../integrations/quickbooks/quickbooks.client");
const echoSuppression = require("../utils/echo.suppression.util");
const mutex = require('../utils/mutex.util');

async function _internalProcessContact(contactId) {
  console.log(`\n--- 👤 Procesando Contacto HS ID: ${contactId} ---`);

  // 1. Obtenemos datos de HubSpot
  // NOTA: Asegúrate de que getContactDetails incluya 'id_usuario_quickbooks' en sus propiedades
  const contactData = await hubspotClient.getContactDetails(contactId);

  if (!contactData) {
    console.log(`❌ Saltando el contacto ${contactId} porque no existen datos válidos.`);
    return null;
  }


  const {
    email,
    firstname: firstName,
    lastname: lastName,
    phone,
    address,
    city,
    state,
    zip,
    country,
  } = contactData.properties;

  const id_usuario_quickbooks = contactData.properties.id_usuario_quickbooks;

  if (!email) {
    console.log("⚠️ El contacto de HubSpot no tiene email. Ignorando sincronización.");
    return null;
  }

  // 2. Resolver Asociación con Empresa (ParentRef)
  let qbParentId = null;
  const associatedCompanyIds = await hubspotClient.getContactAssociatedCompanyIds(contactId);

  if (associatedCompanyIds.length > 0) {
    const hsCompanyId = associatedCompanyIds[0];
    console.log(`🏢 Contacto asociado a Empresa HS ID: ${hsCompanyId}. Resolviendo en QB...`);
    
    const companySyncService = require("./company.sync.service");
    await companySyncService.processCompany(hsCompanyId);
    
    const companyData = await hubspotClient.getCompanyDetails(hsCompanyId);
    if (companyData && companyData.properties.id_usuario_quickbooks) {
      qbParentId = companyData.properties.id_usuario_quickbooks;
      console.log(`✅ Empresa vinculada en QB con ID: ${qbParentId}`);
    }
  }

  // 3. Lógica de Sincronización (Creación o Actualización)
  let qbCustomerId = null;
  let existingCustomer = null;

  // Intentamos localizar por el ID guardado o por email
  if (id_usuario_quickbooks) {
    existingCustomer = await quickbooksClient.getCustomerById(id_usuario_quickbooks).catch(() => null);
  }
  
  if (!existingCustomer) {
    existingCustomer = await quickbooksClient.findCustomerByEmail(email);
  }

  const customerData = {
    email,
    firstName,
    lastName,
    phone,
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
    
    console.log(`🔄 Cliente ENCONTRADO (QB ID: ${qbCustomerId}). Sincronizando cambios...`);
    
    // Si el nombre cambió en HS, QB podría requerir validar el DisplayName único de nuevo,
    // pero al ser Sparse Update usualmente mantenemos el DisplayName original a menos que sea necesario cambiarlo.
    const updatedCustomer = await quickbooksClient.updateCustomer(qbCustomerId, qbSyncToken, customerData);
    qbCustomerId = updatedCustomer.Id;
    
  } else {
    // === CASO B: CREACIÓN ===
    const baseDisplayName = `${firstName || ""} ${lastName || ""}`.trim();
    let finalDisplayName = baseDisplayName || email; // Fallback al email si no hay nombre

    console.log(`✨ El contacto no existe en QB. Verificando disponibilidad de nombre: "${finalDisplayName}"...`);
    const qbCustomerByName = await quickbooksClient.findCustomerByDisplayName(finalDisplayName);

    if (qbCustomerByName) {
      finalDisplayName = `${finalDisplayName} (${email})`;
      console.log(`⚠️ Nombre duplicado. Ajustando DisplayName a: "${finalDisplayName}"`);
    }

    const newQbCustomer = await quickbooksClient.createCustomer({
      ...customerData,
      displayName: finalDisplayName
    });
    qbCustomerId = newQbCustomer.Id;
    console.log(`✅ Cliente CREADO en QB (ID: ${qbCustomerId})`);
  }

  // 4. Actualizamos el ID en HubSpot (con supresión de eco)
  if (!id_usuario_quickbooks || id_usuario_quickbooks !== qbCustomerId.toString()) {
    console.log(`🔗 Enlazando ID de QuickBooks ${qbCustomerId} en HubSpot...`);
    
    // 🌟 CLAVE: Marcamos este ID antes de actualizar HubSpot para que el Webhook entrante sea ignorado
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
}

// Esta es la función que exportas y que todos llamarán
async function processContact(contactId) {
    // Aquí es donde aplicamos el candado globalmente
    return mutex.runSequentially(contactId, async () => {
        return await _internalProcessContact(contactId);
    });
}

module.exports = { processContact };