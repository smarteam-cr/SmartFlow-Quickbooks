// src/services/job.service.js
const SyncJob = require('../db/models/job.model');
const dedupeService = require('./dedupe.service');
const backoffUtil = require('../utils/backoff.util');
const config = require('../config');
const logger = require('../lib/logger.lib');
const { JOB_STATUS } = require('../config/constants');
const { v4: uuidv4 } = require('uuid');

async function createJob(jobData) {
  const { tenantId, source, entity, entityId, eventType, payload, correlationId } = jobData;

  // 1. Calcular llave de deduplicación
  const dedupeKey = dedupeService.buildDedupeKey({ tenantId, source, entity, entityId, eventType, payload });

  // 2. Verificar duplicado exacto
  if (await dedupeService.isDuplicate(dedupeKey)) {
    logger.info(`[JobService] Evento duplicado ignorado en puerta`, { dedupeKey, entity, entityId });
    return null; // No guardamos el Job
  }

  // 3. Crear Job
  const job = await SyncJob.create({
    tenantId,
    source,
    entity,
    entityId: String(entityId),
    eventType,
    payload,
    correlationId: correlationId || uuidv4(),
    dedupeKey,
  status: JOB_STATUS.PENDING,
    maxAttempts: config.worker.maxRetryAttempts,
  });

  // 4. Registrar la huella para los próximos 5 minutos
  await dedupeService.markAsSeen(tenantId, dedupeKey, job._id);
  
  return job; 
}

async function markProcessing(jobId) {
  return SyncJob.findByIdAndUpdate(
    jobId, 
    { status: JOB_STATUS.PROCESSING, $inc: { attempts: 1 } }, 
    { returnDocument: 'after' }
  );
}

async function markCompleted(jobId) {
  return SyncJob.findByIdAndUpdate(
    jobId, 
    { status: JOB_STATUS.COMPLETED, completedAt: new Date() }, 
    { returnDocument: 'after' }
  );
}

async function markSkipped(jobId, reason) {
  return SyncJob.findByIdAndUpdate(
    jobId, 
    { status: JOB_STATUS.SKIPPED, lastError: reason, completedAt: new Date() }, 
    { returnDocument: 'after' }
  );
}

async function markFailed(jobId, errorMessage, errorStack, errorObject = null) {
  const job = await SyncJob.findById(jobId);
  if (!job) return;

  // Evaluar si es un error temporal (503, 429) o definitivo (400)
  const isRetryable = errorObject ? backoffUtil.isRetryableError(errorObject) : true;

  // Decidir nuevo estado
  const newStatus = (isRetryable && job.attempts < job.maxAttempts)
    ? JOB_STATUS.RETRY_PENDING
    : JOB_STATUS.DEAD_LETTER;

  // Calcular próxima ejecución si amerita reintento
  const nextRetryAt = newStatus === JOB_STATUS.RETRY_PENDING
    ? backoffUtil.calculateNextRetry(job.attempts)
    : undefined;

  return SyncJob.findByIdAndUpdate(jobId, {
    status: newStatus,
    lastError: errorMessage,
    lastErrorStack: errorStack,
    isRetryable,
    ...(nextRetryAt && { nextRetryAt }),
    ...(newStatus === JOB_STATUS.DEAD_LETTER && { completedAt: new Date() }),
  }, { returnDocument: 'after' });
}

// Métodos para el Poller del Worker
async function getPendingJobs(tenantId, limit = 10) {
  return SyncJob.find({ tenantId, status: JOB_STATUS.PENDING }).sort({ createdAt: 1 }).limit(limit);
}

async function getRetryableJobs(tenantId, limit = 10) {
  return SyncJob.find({
    tenantId,
    status: JOB_STATUS.RETRY_PENDING,
    nextRetryAt: { $lte: new Date() }, // Ya pasó su tiempo de espera
  }).sort({ nextRetryAt: 1 }).limit(limit);
}

module.exports = { 
  createJob, 
  markProcessing, 
  markCompleted, 
  markSkipped, 
  markFailed, 
  getPendingJobs, 
  getRetryableJobs 
};