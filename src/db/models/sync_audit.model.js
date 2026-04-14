const mongoose = require('mongoose');

const syncAuditSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'SyncJob' },
  correlationId: { type: String, index: true },
  entity: { type: String },
  entityId: { type: String },
  action: { type: String },         // 'created', 'updated', 'skipped', 'suppressed', 'failed'
  source: { type: String },
  target: { type: String },
  description: { type: String },    // Ej: "Factura omitida porque saldo_pendiente > 0"
  durationMs: { type: Number },
  success: { type: Boolean }
}, { timestamps: true });

// Índice para listar el historial reciente rápidamente
syncAuditSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('SyncAudit', syncAuditSchema);