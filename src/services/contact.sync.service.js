const hubspotClient = require("../integrations/hubspot/hubspot.client");
const quickbooksClient = require("../integrations/quickbooks/quickbooks.client");

async function processContact(contactId) {
  // 1. Obtenemos datos de HubSpot
  const contactData = await hubspotClient.getContactDetails(contactId);

  if (!contactData) {
    console.log(`Saltando el contacto ${contactId} porque no existen datos válidos.`);
    return null; // <-- DEVOLVEMOS NULL
  }

  const {
    email,
    firstname: firstName,
    lastname: lastName,
    phone,
    address,
    city,
    country,
  } = contactData.properties;

  // Extraemos la propiedad de HubSpot para ver si YA sabíamos el ID
  const id_usuario_quickbooks = contactData.properties.id_usuario_quickbooks;

  console.log(`Buscando en QuickBooks el correo: ${email}...`);

  if (!email) {
    console.log("El contacto de HubSpot no tiene email. Ignorando sincronización.");
    return null; // <-- DEVOLVEMOS NULL
  }

  // 2. Lógica de Búsqueda Robusta y Creación
  let qbCustomerId = null;

  // A. Buscar por Correo
  const qbCustomerByEmail = await quickbooksClient.findCustomerByEmail(email);

  if (qbCustomerByEmail) {
    qbCustomerId = qbCustomerByEmail.Id;
    console.log(`¡Cliente ENCONTRADO en QuickBooks por email! Su ID es: ${qbCustomerId}`);
  } else {
    // B. Escudo anti Error 400: Buscar por Nombre Exacto (DisplayName)
    const displayName = `${firstName || ""} ${lastName || ""}`.trim();
    console.log(`El correo no existe en QB. Buscando por nombre exacto: "${displayName}"...`);
    const qbCustomerByName = await quickbooksClient.findCustomerByDisplayName(displayName);

    if (qbCustomerByName) {
      qbCustomerId = qbCustomerByName.Id;
      console.log(`¡Cliente ENCONTRADO en QuickBooks por nombre! Su ID es: ${qbCustomerId}`);
    } else {
      // C. Crearlo si de verdad no existe
      console.log(`El cliente NO existe en QuickBooks. Procediendo a crearlo...`);
      const newQbCustomer = await quickbooksClient.createCustomer({
        email,
        firstName,
        lastName,
        phone,
        address,
        city,
        country,
      });
      qbCustomerId = newQbCustomer.Id;
      console.log(`¡Cliente CREADO EXITOSAMENTE en QuickBooks! ID: ${qbCustomerId}`);
    }
  }

  // 3. Optimización: Solo actualizamos HubSpot si no tenía el ID
  if (!id_usuario_quickbooks || id_usuario_quickbooks !== qbCustomerId.toString()) {
    await hubspotClient.updateContactProperty(contactId, qbCustomerId);
    console.log(`ID de QuickBooks (${qbCustomerId}) guardado exitosamente en HubSpot.`);
  } else {
    console.log(`El contacto en HubSpot ya tenía su ID anclado. Omitiendo actualización redundante.`);
  }

  // --- LA LÍNEA MÁGICA ---
  // Devolvemos el número final al Orquestador de Facturas
  return qbCustomerId;
}

module.exports = { processContact };