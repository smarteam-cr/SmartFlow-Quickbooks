const hubspotClient = require('../integrations/hubspot/hubspot.client.js');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client.js');

const syncHistoricalContacts = async (request, reply) => {
  try {
    console.log("\n === INICIANDO MIGRACIÓN MASIVA DE CONTACTOS HISTÓRICOS ===");
    
    // 1. Traer todos los contactos de HubSpot
    const contacts = await hubspotClient.getAllContacts();
    
    let stats = { procesados: 0, saltados: 0, errores: 0 };

    // 2. Iterar sobre cada contacto (usamos for...of para que sea secuencial y no saturar la API)
    for (const contact of contacts) {
      const contactId = contact.id;
      const email = contact.properties.email;
      const firstName = contact.properties.firstname;
      const lastName = contact.properties.lastname;
      const qbId = contact.properties.id_usuario_quickbooks; 

      // Si ya tiene el ID de QuickBooks, o si no tiene correo, lo saltamos
      if (qbId || !email) {
        stats.saltados++;
        continue; 
      }

      console.log(`\n Procesando contacto histórico: ${email}...`);

      try {
        let finalQbId = null;
        
        // 3. Reutilizamos nuestra lógica core: Buscar o Crear
        const qbCustomer = await quickbooksClient.findCustomerByEmail(email);

        if (qbCustomer) {
          console.log(`Existe en QuickBooks. ID: ${qbCustomer.Id}`);
          finalQbId = qbCustomer.Id;
        } else {
          console.log(`No existe en QuickBooks. Creando...`);
          const newCustomer = await quickbooksClient.createCustomer({ email, firstName, lastName });
          finalQbId = newCustomer.Id;
        }

        // 4. Actualizar HubSpot
        await hubspotClient.updateContactProperty(contactId, finalQbId);
        console.log(`HubSpot actualizado con éxito.`);
        stats.procesados++;

      } catch (err) {
        console.error(`Error procesando a ${email}:`, err.message);
        stats.errores++;
      }
    }

    console.log("\n=== MIGRACIÓN FINALIZADA ===");
    console.log(`Resultados: Procesados (${stats.procesados}) | Saltados (${stats.saltados}) | Errores (${stats.errores})`);

    // Respondemos a quien llamó la API
    return reply.code(200).send({
      message: 'Migración histórica completada',
      resultados: stats
    });

  } catch (error) {
    console.error("Error crítico en la migración:", error);
    return reply.code(500).send({ error: 'Fallo la migración masiva' });
  }
};

module.exports = {
  syncHistoricalContacts
};