const hubspotClient = require("../integrations/hubspot/hubspot.client");
const quickbooksClient = require("../integrations/quickbooks/quickbooks.client");

async function processContact(contactId) {
  // 1. Obtenemos datos de HubSpot
  const contactData = await hubspotClient.getContactDetails(contactId);

  // Si contactData es null (por el error 404), no hacemos nada
  if (!contactData) {
    console.log(
      `Saltando el contacto ${contactId} porque no existen datos válidos.`,
    );
    return;
  }

  const {
    email,
    firstname: firstName,
    lastname: lastName,
  } = contactData.properties;

  console.log(`Buscando en QuickBooks el correo: ${email}...`);

  if (!email) {
    console.log(
      "El contacto de HubSpot no tiene email. Ignorando sincronización.",
    );
    return;
  }

  // 2. Buscamos en QuickBooks
  const qbCustomer = await quickbooksClient.findCustomerByEmail(email);

  if (qbCustomer) {
    console.log(
      `¡Cliente ENCONTRADO en QuickBooks! Su ID es: ${qbCustomer.Id}`,
    );
    await hubspotClient.updateContactProperty(contactId, qbCustomer.Id);
    console.log(
      `ID de QuickBooks (${qbCustomer.Id}) actualizado exitosamente en HubSpot.`,
    );
  } else {
    console.log(`El cliente NO existe en QuickBooks. Procediendo a crearlo...`);
    const newQbCustomer = await quickbooksClient.createCustomer({
      email,
      firstName,
      lastName,
    });
    console.log(
      `¡Cliente CREADO EXITOSAMENTE en QuickBooks! ID: ${newQbCustomer.Id}`,
    );
    await hubspotClient.updateContactProperty(contactId, newQbCustomer.Id);
    console.log(
      `Nuevo ID de QuickBooks (${newQbCustomer.Id}) guardado exitosamente en HubSpot.`,
    );
  }
}

module.exports = { processContact };
