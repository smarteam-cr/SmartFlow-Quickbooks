const EntityMapping = require('../db/models/entity_mapping.model');

async function findByHsId(tenantId, entityType, hsId) {
  return EntityMapping.findOne({ tenantId, entityType, hsId: String(hsId) });
}

async function findByQbId(tenantId, entityType, qbId) {
  return EntityMapping.findOne({ tenantId, entityType, qbId: String(qbId) });
}

/**
 * Crea o actualiza el registro de mapeo. 
 * Guarda el SyncToken de QB (necesario para updates) y el hash del payload para idempotencia.
 */
async function upsertMapping({ tenantId, entityType, hsId, qbId, qbSyncToken, payloadHash, sourceSystem }) {
  // Buscamos si ya existe el mapeo por el ID de HubSpot o el de QuickBooks
  const query = { 
    tenantId, 
    entityType, 
    $or: [{ hsId: String(hsId) }, { qbId: String(qbId) }] 
  };

  const update = {
    tenantId,
    entityType,
    hsId: String(hsId),
    qbId: String(qbId),
    ...(qbSyncToken && { qbSyncToken: String(qbSyncToken) }),
    ...(payloadHash && { payloadHash }),
    lastSyncedAt: new Date(),
    lastSourceSystem: sourceSystem
  };

  return EntityMapping.findOneAndUpdate(
    query,
    update,
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
}

module.exports = { findByHsId, findByQbId, upsertMapping };