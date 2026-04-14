const mongoose = require('mongoose');
const { JOB_STATUS, SOURCES, ENTITIES } = require('../../config/constants');

const syncJobSchema = new mongoose.Schema({
  // Identificadores
  tenantId: { type: String, required: true, index: true },
  correlationId: { type: String, index: true },
  
  // Origen del evento
  source: { type: String, required: true, enum: Object.values(SOURCES) },
  entity: { type: String, required: true, enum: Object.values(ENTITIES) },
  entityId: { type: String, required: true },
  eventType: { type: String, required: true },
  
  // Payload original que disparó el evento
  payload: { type: mongoose.Schema.Types.Mixed },
  
  // Deduplicación
  dedupeKey: { type: String, index: true },
  
  // Estado y control de ciclo de vida
  status: {
    type: String,
    required: true,
    enum: Object.values(JOB_STATUS),
    default: JOB_STATUS.PENDING,
    index: true,
  },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 3 },
  nextRetryAt: { type: Date, index: true },
  
  // Resultados y auditoría
  lastError: { type: String },
  lastErrorStack: { type: String },
  isRetryable: { type: Boolean, default: true },
  completedAt: { type: Date }
}, { timestamps: true });

// Índices compuestos para que las consultas del Worker sean ultrarrápidas
syncJobSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
syncJobSchema.index({ status: 1, nextRetryAt: 1 }); // Clave para el poller de reintentos
syncJobSchema.index({ tenantId: 1, dedupeKey: 1 });

module.exports = mongoose.model('SyncJob', syncJobSchema);