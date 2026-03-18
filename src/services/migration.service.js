const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');

async function syncHistoricalContacts() {
  console.log('\n === INICIANDO MIGRACIÓN MASIVA DE CONTACTOS HISTÓRICOS ===');

  // 1. Traer todos los contactos de HubSpot
  const contacts = await hubspotClient.getAllContacts();

  let stats = { procesados: 0, saltados: 0, errores: 0 };

  // 2. Iteramos secuencialmente para no saturar las APIs
  for (const contact of contacts) {
    const contactId = contact.id;
    const { email, firstname: firstName, lastname: lastName, id_usuario_quickbooks: qbId } = contact.properties;

    // Si ya tiene ID de QuickBooks o no tiene email, lo saltamos
    if (qbId || !email) {
      stats.saltados++;
      continue;
    }

    console.log(`\n Procesando contacto histórico: ${email}...`);

    try {
      let finalQbId = null;

      // 3. Buscar o Crear en QuickBooks
      const qbCustomer = await quickbooksClient.findCustomerByEmail(email);

      if (qbCustomer) {
        console.log(`Existe en QuickBooks. ID: ${qbCustomer.Id}`);
        finalQbId = qbCustomer.Id;
      } else {
        console.log(`No existe en QuickBooks. Creando...`);
        const newCustomer = await quickbooksClient.createCustomer({ email, firstName, lastName });
        finalQbId = newCustomer.Id;
      }

      // 4. Actualizar HubSpot con el ID de QuickBooks
      await hubspotClient.updateContactProperty(contactId, finalQbId);
      console.log(`HubSpot actualizado con éxito.`);
      stats.procesados++;

    } catch (err) {
      console.error(`Error procesando a ${email}:`, err.message);
      stats.errores++;
    }
  }

  console.log('\n=== MIGRACIÓN FINALIZADA ===');
  console.log(`Resultados: Procesados (${stats.procesados}) | Saltados (${stats.saltados}) | Errores (${stats.errores})`);

  return stats;
}

module.exports = { syncHistoricalContacts };