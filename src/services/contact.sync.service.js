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
    state,
    zip,
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

  // A. Buscar por Correo (Es el identificador real)
  const qbCustomerByEmail = await quickbooksClient.findCustomerByEmail(email);

  if (qbCustomerByEmail) {
    qbCustomerId = qbCustomerByEmail.Id;
    console.log(`¡Cliente ENCONTRADO en QuickBooks por email! Su ID es: ${qbCustomerId}`);
  } else {
    // B. Escudo anti Error 400 (DisplayName debe ser único en QB)
    // Como el correo no se encontró, es un contacto NUEVO. 
    // Pero debemos validar si su nombre ya lo está usando otra persona.
    const baseDisplayName = `${firstName || ""} ${lastName || ""}`.trim();
    let finalDisplayName = baseDisplayName;

    console.log(`El correo no existe en QB. Verificando disponibilidad del nombre: "${baseDisplayName}"...`);
    const qbCustomerByName = await quickbooksClient.findCustomerByDisplayName(baseDisplayName);

    if (qbCustomerByName) {
      // ¡El nombre ya existe! Le concatenamos el email para que sea único en QB
      finalDisplayName = `${baseDisplayName} (${email})`;
      console.log(`⚠️ El nombre ya está en uso. Modificando DisplayName a: "${finalDisplayName}"`);
    }

    // C. Crearlo como un cliente totalmente nuevo
    console.log(`Procediendo a crear el NUEVO cliente en QuickBooks...`);
    const newQbCustomer = await quickbooksClient.createCustomer({
      email,
      firstName,
      lastName,
      displayName: finalDisplayName // Pasamos el nombre único con o sin el correo
    });
    qbCustomerId = newQbCustomer.Id;
    console.log(`¡Cliente CREADO EXITOSAMENTE en QuickBooks! ID: ${qbCustomerId}`);
  }

  // 3. Optimización: Solo actualizamos HubSpot si no tenía el ID
  if (!id_usuario_quickbooks || id_usuario_quickbooks !== qbCustomerId.toString()) {
    await hubspotClient.updateContactProperty(contactId, qbCustomerId);
    console.log(`ID de QuickBooks (${qbCustomerId}) guardado exitosamente en HubSpot.`);
  } else {
    console.log(`El contacto en HubSpot ya tenía su ID anclado. Omitiendo actualización redundante.`);
  }

  const contactInfo = {
    displayName: (qbCustomerByEmail ? qbCustomerByEmail.DisplayName : finalDisplayName) || `${firstName || ""} ${lastName || ""}`.trim(),
    address,
    city,
    state,
    zip,
    country
  };

  // --- LA LÍNEA MÁGICA ---
  // Devolvemos el número final al Orquestador de Facturas
  return { qbCustomerId, contactInfo };
}

module.exports = { processContact };