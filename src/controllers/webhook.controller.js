const webhookService = require('../services/webhook.service');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');

async function handleQuickBooksWebhook(request, reply) {
  try {
    console.log('[Controller] Webhook de QuickBooks recibido');

    const payload = request.body;

    // Le pasamos el paquete al cerebro de forma asíncrona (en segundo plano)
    // No usamos 'await' aquí para poder responderle a QuickBooks inmediatamente con el 200 OK
    webhookService.procesarNotificacion(payload).catch(err => {
      console.error('Error en el proceso en segundo plano:', err.message);
    });

    // Respondemos a QuickBooks súper rápido
    return reply.status(200).send('Webhook recibido y en proceso');
  } catch (error) {
    console.error('Error en el controlador:', error);
    return reply.status(500).send('Error interno del servidor');
  }
}

const handleHubSpotWebhook = async (request, reply) => {
  try {
    const events = request.body;

    for (const event of events) {
      if (event.subscriptionType === 'contact.creation') {
        const contactId = event.objectId;
        console.log(`\n=== Procesando nuevo contacto ID: ${contactId} ===`);

        // 1. Obtenemos datos de HubSpot
        const contactData = await hubspotClient.getContactDetails(contactId);

        // Si contactData es null (por el error 404), saltamos este evento
        if (!contactData) {
          console.log(`Saltando el contacto ${contactId} porque no existen datos válidos.`);
          continue; // Pasa al siguiente evento en el bucle 'for'
        }
        const email = contactData.properties.email;
        const firstName = contactData.properties.firstname;
        const lastName = contactData.properties.lastname;


        console.log(`Buscando en QuickBooks el correo: ${email}...`);

        // 2. Buscamos en QuickBooks
        if (email) {
          const qbCustomer = await quickbooksClient.findCustomerByEmail(email);

          if (qbCustomer) {
            console.log(`¡Cliente ENCONTRADO en QuickBooks! Su ID es: ${qbCustomer.Id}`);

            // Enviamos el ID encontrado de regreso a HubSpot
            await hubspotClient.updateContactProperty(contactId, qbCustomer.Id);
            console.log(`ID de QuickBooks (${qbCustomer.Id}) actualizado exitosamente en HubSpot.`);

          } else {
            console.log(`El cliente NO existe en QuickBooks. Procediendo a crearlo...`);

            // Llamamos a la nueva función pasándole los datos extraídos de HubSpot
            const newQbCustomer = await quickbooksClient.createCustomer({
              email: email,
              firstName: firstName,
              lastName: lastName,
            });

            console.log(`¡Cliente CREADO EXITOSAMENTE en QuickBooks!`);
            console.log(`ID generado por QuickBooks: ${typeof newQbCustomer.Id}`);

            await hubspotClient.updateContactProperty(contactId, newQbCustomer.Id);
            console.log(`Nuevo ID de QuickBooks (${newQbCustomer.Id}) guardado exitosamente en HubSpot.`);

          }
        } else {
          console.log('El contacto de HubSpot no tiene email. Ignorando sincronización.');
        }
        console.log('=================================================');
      }
    }

    return reply.code(200).send({ status: 'success' });
  } catch (error) {
    console.error('Error al procesar el webhook de HubSpot:', error);
    return reply.code(500).send({ status: 'error' });
  }
};

module.exports = { handleQuickBooksWebhook, handleHubSpotWebhook };
