const webhookController = require('../controllers/webhook.controller');
const authMiddleware = require('../middlewares/auth.middleware');

/**
 * Esquema de validación para Webhooks de HubSpot.
 * Valida que el body sea un array y tenga las propiedades mínimas necesarias.
 */
const hubspotWebhookSchema = {
  body: {
    type: 'array',
    items: {
      type: 'object',
      oneOf: [
        { required: ['objectId', 'subscriptionType'] },
        { required: ['fromObjectId', 'subscriptionType'] }
      ]
    }
  }
};

/**
 * Esquema de validación para Webhooks de QuickBooks.
 * Acepta formato legacy (eventNotifications) y CloudEvents (array).
 */
const qbWebhookSchema = {
  body: {
    oneOf: [
      {
        type: 'object',
        required: ['eventNotifications'],
        properties: {
          eventNotifications: { type: 'array' }
        }
      },
      {
        type: 'array',
        items: {
          type: 'object',
          required: ['specversion', 'type', 'intuitentityid']
        }
      }
    ]
  }
};

async function webhookRoutes(fastify, options) {
  // QuickBooks: Validamos firma e integridad del esquema
  fastify.post('/quickbooks', {
    schema: qbWebhookSchema,
    preHandler: authMiddleware.validateIntuitSignature
  }, webhookController.handleQuickBooksWebhook);

  // HubSpot Estándar: Validamos firma y esquema
  fastify.post('/hubspot', {
    schema: hubspotWebhookSchema,
    preHandler: authMiddleware.validateHubSpotSignature
  }, webhookController.handleHubSpotWebhook);
}

module.exports = webhookRoutes;