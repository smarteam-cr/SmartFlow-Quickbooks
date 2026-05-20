// src/controllers/webhook.controller.js
const jobService = require('../services/job.service');
const logger = require('../lib/logger.lib');
const { responseHelper } = require('../lib/response.lib');
const { DEFAULT_TENANT_ID, SOURCES, ENTITIES } = require('../config/constants');

/**
 * Mapeo de entidades de QuickBooks a nuestro estándar interno
 */
const QB_ENTITY_MAP = {
  'Item': ENTITIES.PRODUCT,
  'Customer': ENTITIES.CONTACT
};

/**
 * Maneja Webhooks de QuickBooks
 */
async function handleQuickBooksWebhook(request, reply) {
  console.log("--------------------------------------------QUICKBOOKS--------------------------------------------")
  const payload = request.body;
  const tenantId = DEFAULT_TENANT_ID;

  if (Array.isArray(payload)) {
    // Formato CloudEvents (activo desde agosto 2026)
    // type: "com.intuit.quickbooks.Customer.Create" → entityName="Customer", operation="Create"
    logger.info(`[Webhook/QB] CloudEvents: ${payload.length} evento(s).`, { correlationId: request.correlationId });

    for (const event of payload) {
      const parts = (event.type || '').split('.');
      if (parts.length < 2) continue;

      const operation = parts[parts.length - 1];
      const entityName = parts[parts.length - 2];
      const entityId = String(event.intuitentityid || '');

      if (!entityId) continue;

      if (entityName === 'Invoice' && operation === 'Emailed') {
        await jobService.createJob({
          tenantId,
          source: SOURCES.QUICKBOOKS,
          entity: ENTITIES.INVOICE,
          entityId,
          eventType: 'qb.invoice.emailed',
          payload: event,
          correlationId: request.correlationId
        });
        continue;
      }

      const internalEntity = QB_ENTITY_MAP[entityName];
      const validOps = ['Create', 'Update', 'Emailed'];

      if (internalEntity && validOps.includes(operation)) {
        await jobService.createJob({
          tenantId,
          source: SOURCES.QUICKBOOKS,
          entity: internalEntity,
          entityId,
          eventType: `qb.${entityName.toLowerCase()}.${operation.toLowerCase()}`,
          payload: event,
          correlationId: request.correlationId
        });
      }
    }
  } else if (payload.eventNotifications) {
    // Formato legacy (pre-CloudEvents)
    for (const notification of payload.eventNotifications) {
      for (const entity of notification.dataChangeEvent.entities) {
        // Caso especial: Factura enviada por email en QB
        if (entity.name === 'Invoice' && entity.operation === 'Emailed') {
          await jobService.createJob({
            tenantId,
            source: SOURCES.QUICKBOOKS,
            entity: ENTITIES.INVOICE,
            entityId: String(entity.id),
            eventType: 'qb.invoice.emailed',
            payload: entity,
            correlationId: request.correlationId
          });
          continue;
        }

        const internalEntity = QB_ENTITY_MAP[entity.name];
        const validOps = ['Create', 'Update', 'Emailed'];

        if (internalEntity && validOps.includes(entity.operation)) {
          await jobService.createJob({
            tenantId,
            source: SOURCES.QUICKBOOKS,
            entity: internalEntity,
            entityId: String(entity.id),
            eventType: `qb.${entity.name.toLowerCase()}.${entity.operation.toLowerCase()}`,
            payload: entity,
            correlationId: request.correlationId
          });
        }
      }
    }
  }

  return reply.status(200).send('OK');
}

/**
 * Maneja Webhooks de HubSpot
 */
async function handleHubSpotWebhook(request, reply) {
  console.log("--------------------------------------------HUBSPOT--------------------------------------------")
  const events = request.body;
  const tenantId = DEFAULT_TENANT_ID;

  logger.info(`[Webhook/HS] Recibidos ${events.length} eventos.`, { correlationId: request.correlationId });

  for (const event of events) {
    const targetId = event.fromObjectId || event.objectId;
    if (!targetId) continue;

    // Lógica de mapeo de entidades HubSpot
    let internalEntity = null;
    const type = event.subscriptionType;

    if (type.startsWith('contact.')) internalEntity = ENTITIES.CONTACT;
    else if (type.startsWith('company.')) internalEntity = ENTITIES.COMPANY;
    else if (type.startsWith('product.')) internalEntity = ENTITIES.PRODUCT;
    
    // Casos especiales (Facturas y Line Items)
    if (event.objectTypeId === '0-53') {
      internalEntity = ENTITIES.INVOICE;

      // --- ESCUDO PARA FACTURAS (hs_balance_due) ---
      if (type === 'object.propertyChange' && event.propertyName === 'hs_balance_due') {
        const balance = Number(event.propertyValue);
        if (isNaN(balance) || balance > 0) {
          logger.info(`[Webhook/HS] Factura ${targetId} con saldo parcial (${event.propertyValue}). Ignorando.`);
          continue;
        }
        event.subscriptionType = 'object.creation'; // Transformación para disparo en QB
      } else if (type === 'object.creation') {
        continue; // Bloqueo de seguridad HS
      }
    } else if (event.objectTypeId === '0-101') {
      internalEntity = ENTITIES.HS_PAYMENT;
    } else if (event.objectTypeId === '0-7') {
      // Products en HS siempre llegan con subscriptionType=object.* (no
      // existe el alias clásico product.*); el objectTypeId es el único
      // discriminador confiable.
      internalEntity = ENTITIES.PRODUCT;
    }

    if (internalEntity) {
      // Encolar con el nuevo formato V2.0 (tenantId requerido)
      try {
        const job = await jobService.createJob({
          tenantId,
          source: SOURCES.HUBSPOT,
          entity: internalEntity,
          entityId: String(targetId),
          eventType: event.subscriptionType,
          payload: event,
          correlationId: request.correlationId
        });
        
        if (job) {
          logger.info(`✅ Job encolado [${job._id}] para ${internalEntity} ID: ${targetId}`);
        }
      } catch (err) {
        logger.error(`❌ Error encolando job: ${err.message}`, { correlationId: request.correlationId });
      }
    }
  }

  return reply.code(200).send(responseHelper.success({ processed: events.length }));
}

module.exports = {
  handleQuickBooksWebhook,
  handleHubSpotWebhook
};