// src/tasks/worker.js
const SyncJob = require('../db/models/job.model');
const jobService = require('../services/job.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
// Nota: Importaremos productos y facturas a medida que los refactoricemos
const mutex = require('../utils/mutex.util');
const logger = require('../lib/logger.lib');
const config = require('../config');
const { SOURCES, ENTITIES, JOB_STATUS } = require('../config/constants');

const CONCURRENCY = config.worker.concurrency || 3;
let activeJobs = 0;

/**
 * Orquestador de ejecución para un Job específico
 */
async function processJob(job) {
  const { source, entity, entityId, _id, tenantId, correlationId } = job;
  const startTime = Date.now();

  logger.info(`[Worker] Iniciando Job [${_id}]`, { entity, entityId, correlationId, attempt: job.attempts + 1 });
  
  await jobService.markProcessing(_id);

  try {
    if (source === SOURCES.HUBSPOT) {
      await routeHubSpotJob(job);
    } else if (source === SOURCES.QUICKBOOKS) {
      await routeQuickBooksJob(job);
    }

    await jobService.markCompleted(_id);
    logger.info(`✅ Job [${_id}] completado en ${Date.now() - startTime}ms`);

  } catch (error) {
    logger.error(`❌ Job [${_id}] falló: ${error.message}`, { 
      correlationId, 
      stack: config.nodeEnv !== 'production' ? error.stack : undefined 
    });
    
    // El servicio de jobs decidirá si va a RETRY_PENDING o DEAD_LETTER
    await jobService.markFailed(_id, error.message, error.stack, error);
  }
}

/**
 * Enrutador para eventos originados en HubSpot
 */
async function routeHubSpotJob(job) {
  const { entity, entityId, tenantId } = job;

  switch (entity) {
    case ENTITIES.CONTACT:
      await contactSyncService.processContact(entityId, tenantId);
      break;
    case ENTITIES.COMPANY:
      await companySyncService.processCompany(entityId, tenantId);
      break;
    // Los demás casos se activarán al refactorizar sus servicios
    default:
      logger.warn(`[Worker] Entidad HS no soportada o pendiente: ${entity}`);
      await jobService.markSkipped(job._id, 'Entidad no soportada');
  }
}

/**
 * Enrutador para eventos originados en QuickBooks
 */
async function routeQuickBooksJob(job) {
  const { entity, entityId, tenantId } = job;

  switch (entity) {
    case ENTITIES.CONTACT:
      await contactSyncService.syncCustomerFromQuickbooks(entityId, tenantId);
      break;
    case ENTITIES.COMPANY:
      await companySyncService.syncCompanyFromQuickbooks(entityId, tenantId);
      break;
    default:
      logger.warn(`[Worker] Entidad QB no soportada o pendiente: ${entity}`);
      await jobService.markSkipped(job._id, 'Entidad no soportada');
  }
}

/**
 * Control de flujo y Mutex
 */
async function scheduleJob(job) {
  if (activeJobs >= CONCURRENCY) return; 

  activeJobs++;
  try {
    // El Mutex garantiza que si llegan 4 eventos del mismo ID, se procesen uno tras otro
    await mutex.runSequentially(job.entityId, () => processJob(job));
  } finally {
    activeJobs--;
  }
}

/**
 * Poller de Reintentos (cada 30 segundos)
 */
function startRetryPoller() {
  setInterval(async () => {
    try {
      // Buscamos jobs de cualquier tenant que necesiten reintento
      const retryJobs = await SyncJob.find({
        status: JOB_STATUS.RETRY_PENDING,
        nextRetryAt: { $lte: new Date() }
      }).limit(CONCURRENCY);

      for (const job of retryJobs) {
        scheduleJob(job);
      }
    } catch (err) {
      logger.error(`[Worker] Error en retry poller: ${err.message}`);
    }
  }, 30000);
}

async function startWorker() {
  logger.info(`👷 Worker V2.0 iniciado (Concurrencia: ${CONCURRENCY})`);

  try {
    // 1. Procesar rezagados al arrancar
    const pending = await SyncJob.find({ status: JOB_STATUS.PENDING }).sort({ createdAt: 1 });
    for (const job of pending) {
      scheduleJob(job);
    }

    // 2. Escuchar nuevos jobs vía Change Stream
    const changeStream = SyncJob.watch([{ $match: { operationType: 'insert' } }]);
    changeStream.on('change', async (change) => {
      const job = await SyncJob.findById(change.documentKey._id);
      if (job && job.status === JOB_STATUS.PENDING) {
        scheduleJob(job);
      }
    });

    // 3. Iniciar recuperador de fallos temporales
    startRetryPoller();

  } catch (err) {
    logger.error('💥 Error crítico en Change Stream:', err);
  }
}

module.exports = { startWorker };