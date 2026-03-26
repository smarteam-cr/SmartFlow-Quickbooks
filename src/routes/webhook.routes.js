const webhookController = require('../controllers/webhook.controller');

async function webhookRoutes(fastify, options) {
  // Definimos que cuando llegue un POST a /quickbooks, lo maneje el controlador de QuickBooks
  fastify.post('/quickbooks', webhookController.handleQuickBooksWebhook);

  // Definimos que cuando llegue un POST a /hubspot2, lo maneje el controlador de HubSpot
  fastify.post('/hubspot2', webhookController.handleHubSpotWebhook);

  // Definimos que cuando llegue un POST a /hubspot/deal-simulated, lo maneje el controlador de HubSpot
  fastify.post('/hubspot/deal-simulated', webhookController.handleHubspotDealWebhook);
}

module.exports = webhookRoutes;