const crypto = require('crypto');
const EventDedup = require('../db/models/event_dedup.model');
const logger = require('../lib/logger.lib');

function buildDedupeKey({ tenantId, source, entity, entityId, eventType, payload }) {
  // Creamos un hash corto del payload para no guardar JSON gigantes en la clave
  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex')
    .slice(0, 16); 

  return `${tenantId}:${source}:${entity}:${entityId}:${eventType}:${payloadHash}`;
}

async function isDuplicate(dedupeKey) {
  try {
    const existing = await EventDedup.findOne({ dedupeKey });
    return !!existing;
  } catch (err) {
    logger.warn(`[Dedupe] Error consultando duplicado, asumiendo falso: ${err.message}`);
    return false; // Ante la duda, dejamos pasar para no perder datos
  }
}

async function markAsSeen(tenantId, dedupeKey, jobId) {
  try {
    await EventDedup.create({ tenantId, dedupeKey, jobId });
  } catch (err) {
    if (err.code !== 11000) { // Ignoramos errores de llave duplicada (11000)
      logger.warn(`[Dedupe] Error marcando evento como visto: ${err.message}`);
    }
  }
}

module.exports = { buildDedupeKey, isDuplicate, markAsSeen };