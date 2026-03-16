const webhookController = require('../controllers/webhook.controller');

async function webhookRoutes(fastify, options) {
  // Definimos que cuando llegue un POST a /webhook, lo maneje el controlador
  fastify.post('/webhook', webhookController.handleQuickBooksWebhook);
}


async function hubSpotWebhook(fastify, opts) {
  // Ya tenías el de QuickBooks, ahora agregamos el de HubSpot
  fastify.post('/webhook/hubspot', webhookController.handleHubSpotWebhook);
}

module.exports = { webhookRoutes, hubSpotWebhook };