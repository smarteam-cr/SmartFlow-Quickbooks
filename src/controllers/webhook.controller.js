const webhookService = require('../services/webhook.service');
const contactSyncService = require('../services/contact.sync.service');

async function handleQuickBooksWebhook(request, reply) {
  try {
    console.log('[Controller] Webhook de QuickBooks recibido');

    const payload = request.body;

    webhookService.processPaymentNotification(payload).catch(err => {
      console.error('Error en el proceso en segundo plano:', err.message);
    });

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

        await contactSyncService.processContact(contactId);

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