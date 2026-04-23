const SyncJob = require('../db/models/job.model');
const jobService = require('../services/job.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const invoiceSyncService = require('../services/invoice.sync.service');
const paymentSyncService = require('../services/payment.sync.service');
const mutex = require('../utils/mutex.util');
const logger = require('../lib/logger.lib');
const config = require('../config');
const { SOURCES, ENTITIES, JOB_STATUS } = require('../config/constants');
const { SkipJobError } = require('../utils/errors.util');

const CONCURRENCY = config.worker.concurrency || 3;
let activeJobs = 0;

/**
 * Función que ejecuta la lógica real del Job
 */
async function processJob(job) {
  const { source, entity, entityId, _id, tenantId, correlationId } = job;
  const startTime = Date.now();

  logger.info(`[Worker] Iniciando Job [${_id}]`, { entity, entityId, correlationId, attempt: job.attempts });

  try {
    if (source === SOURCES.HUBSPOT) {
      await routeHubSpotJob(job);
    } else if (source === SOURCES.QUICKBOOKS) {
      await routeQuickBooksJob(job);
    }

    await jobService.markCompleted(_id);
    logger.info(`✅ Job [${_id}] completado en ${Date.now() - startTime}ms`);

  } catch (error) {
    if (error instanceof SkipJobError) {
      logger.warn(`⏭️  Job [${_id}] omitido (${error.reason}): ${error.message}`, { correlationId });
      await jobService.markSkipped(_id, `${error.reason}: ${error.message}`);
      return;
    }
    logger.error(`❌ Job [${_id}] falló: ${error.message}`, {
      correlationId,
      stack: config.nodeEnv !== 'production' ? error.stack : undefined
    });
    await jobService.markFailed(_id, error.message, error.stack, error);
  }
}

async function routeHubSpotJob(job) {
  const { entity, entityId, tenantId } = job;
  switch (entity) {
    case ENTITIES.CONTACT:
      await contactSyncService.processContact(entityId, tenantId);
      break;
    case ENTITIES.COMPANY:
      await companySyncService.processCompany(entityId, tenantId);
      break;
    case ENTITIES.PRODUCT:
      await productSyncService.processProduct(entityId, tenantId);
      break;
    case ENTITIES.INVOICE:
      await invoiceSyncService.syncInvoiceToQuickbooks(entityId, tenantId);
      break;
    case ENTITIES.HS_PAYMENT:
      await paymentSyncService.syncPaymentToQuickbooks(entityId, tenantId);
      break;
    default:
      logger.warn(`[Worker] Entidad HS no soportada o pendiente: ${entity}`);
      await jobService.markSkipped(job._id, 'Entidad no soportada');
  }
}

async function routeQuickBooksJob(job) {
  const { entity, entityId, tenantId } = job;
  switch (entity) {
    case ENTITIES.CONTACT:
      await contactSyncService.syncCustomerFromQuickbooks(entityId, tenantId);
      break;
    case ENTITIES.COMPANY:
      await companySyncService.syncCompanyFromQuickbooks(entityId, tenantId);
      break;
    case ENTITIES.PRODUCT:
      await productSyncService.syncItemFromQuickbooks(entityId, tenantId);
      break;
    case ENTITIES.INVOICE:
      await invoiceSyncService.handleInvoiceEmailed(entityId, tenantId);
      break;
    default:
      logger.warn(`[Worker] Entidad QB no soportada o pendiente: ${entity}`);
      await jobService.markSkipped(job._id, 'Entidad no soportada');
  }
}

/**
 * 🚀 EL NUEVO MOTOR: Tracción Continua (Pull)
 * Revisa cuántos "slots" hay libres, busca esa cantidad de jobs y los procesa.
 */
async function processNextJobs() {
  if (activeJobs >= CONCURRENCY) return;

  const availableSlots = CONCURRENCY - activeJobs;
  if (availableSlots <= 0) return;

  try {
    // 1. Buscamos N jobs pendientes
    const jobsToProcess = await SyncJob.find({ status: JOB_STATUS.PENDING })
      .sort({ createdAt: 1 })
      .limit(availableSlots);

    for (const job of jobsToProcess) {
      // 2. Intento atómico de reclamar el job cambiándolo a PROCESSING
      const claimedJob = await jobService.markProcessing(job._id);
      if (!claimedJob) continue; // Alguien más lo tomó o fue borrado

      activeJobs++;

      // 3. Ejecutamos de forma asíncrona (Fire & Forget)
      mutex.runSequentially(claimedJob.entityId, () => processJob(claimedJob))
        .finally(() => {
          activeJobs--;
          // 4. ¡LA MAGIA! Al terminar, el Worker revisa si hay más trabajos en el piso
          processNextJobs();
        })
        .catch(err => logger.error(`Error crítico en Mutex: ${err.message}`));
    }
  } catch (error) {
    logger.error(`Error buscando siguientes jobs: ${error.message}`);
  }
}

/**
 * Poller de Reintentos (cada 30 segundos)
 */
function startRetryPoller() {
  setInterval(async () => {
    try {
      const retryJobs = await SyncJob.find({
        status: JOB_STATUS.RETRY_PENDING,
        nextRetryAt: { $lte: new Date() }
      }).limit(CONCURRENCY);

      for (const job of retryJobs) {
        // Regresamos el job a PENDING para que el motor principal lo recoja
        await SyncJob.findByIdAndUpdate(job._id, { status: JOB_STATUS.PENDING });
      }
      
      // Llamamos al motor para procesar inmediatamente si hay espacio
      if (retryJobs.length > 0) processNextJobs();
    } catch (err) {
      logger.error(`[Worker] Error en retry poller: ${err.message}`);
    }
  }, 30000);
}

async function recoverOrphanJobs() {
  const result = await SyncJob.updateMany(
    { status: JOB_STATUS.PROCESSING }, 
    { status: JOB_STATUS.PENDING }
  );
  if (result.modifiedCount > 0) {
    logger.warn(`[Worker] ♻️ ${result.modifiedCount} job(s) huérfano(s) en estado 'processing' recuperados → 'pending'`);
  }
}

async function startWorker() {
  logger.info(`👷 Worker V2.0 iniciado (Concurrencia: ${CONCURRENCY})`);

  try {
    // 1. Recuperar jobs huérfanos que quedaron en 'processing' por un crash anterior
    await recoverOrphanJobs();

    // 2. Encendemos el motor al arrancar para limpiar lo que haya
    processNextJobs();

    // 3. El Change Stream ahora solo "despierta" al motor, no le avienta el Job a la fuerza
    const changeStream = SyncJob.watch([{ $match: { operationType: 'insert' } }]);
    changeStream.on('change', () => {
      processNextJobs();
    });

    // 4. Iniciar recuperador
    startRetryPoller();

  } catch (err) {
    logger.error('💥 Error crítico en Change Stream:', err);
  }
}

module.exports = { startWorker };