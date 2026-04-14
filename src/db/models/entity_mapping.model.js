const mongoose = require('mongoose');

const entityMappingSchema = new mongoose.Schema({
  tenantId: { type: String, required: true },
  entityType: { type: String, required: true }, // 'contact', 'company', 'product', 'invoice'
  hsId: { type: String, sparse: true },         // ID en HubSpot
  qbId: { type: String, sparse: true },         // ID en QuickBooks
  qbSyncToken: { type: String },                // Requerido por QB para updates
  payloadHash: { type: String },                // Hash MD5 del último payload para idempotencia
  lastSyncedAt: { type: Date },
  lastSourceSystem: { type: String }            // 'HUBSPOT' o 'QUICKBOOKS'
}, { timestamps: true });

// Índices únicos por tenant, tipo de entidad y su ID respectivo
entityMappingSchema.index({ tenantId: 1, entityType: 1, hsId: 1 }, { unique: true, sparse: true });
entityMappingSchema.index({ tenantId: 1, entityType: 1, qbId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('EntityMapping', entityMappingSchema);