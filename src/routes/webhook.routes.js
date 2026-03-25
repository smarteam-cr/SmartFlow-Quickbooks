const webhookController = require('../controllers/webhook.controller');

async function webhookRoutes(fastify, options) {
  // Definimos que cuando llegue un POST a /webhook, lo maneje el controlador de QuickBooks
  fastify.post('/webhook', webhookController.handleQuickBooksWebhook);
}


async function hubSpotWebhook(fastify, opts) {
  // Definimos que cuando llegue un POST a /webhook/hubspot, lo maneje el controlador de HubSpot
  fastify.post('/webhook/hubspot2', webhookController.handleHubSpotWebhook);
}

module.exports = { webhookRoutes, hubSpotWebhook };