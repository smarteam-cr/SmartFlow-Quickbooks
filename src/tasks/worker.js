const SyncJob = require('../db/models/job.model');
const jobService = require('../services/job.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const invoiceSyncService = require('../services/invoice.sync.service');
const paymentSyncService = require('../services/payment.sync.service');
const webhookService = require('../services/webhook.service');
const mutex = require('../utils/mutex.util');
const logger = require('../lib/logger.lib');

// Mapeos de propiedades para filtrado (HS)
const MAPPED_CONTACT_PROPS = ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'];
const MAPPED_COMPANY_PROPS = ['name', 'nit', 'phone', 'domain', 'address', 'city', 'country'];
const MAPPED_PRODUCT_PROPS = ['name', 'price', 'hs_price_usd', 'description', 'hs_sku', 'es_gravable'];

async function processJob(job) {
    const { source, entity, entityId, eventType, _id, payload } = job;

    logger.info(`[Worker] Procesando Job [${_id}]`, { 
        jobId: _id, 
        source, 
        entity, 
        entityId, 
        eventType 
    });

    try {
        if (source === 'HUBSPOT') {
            // 1. Filtrado de propiedades (solo para propertyChange de HS)
            if (eventType.includes('propertyChange')) {
                const propertyName = payload.propertyName;
                const propMap = {
                    contact: MAPPED_CONTACT_PROPS,
                    company: MAPPED_COMPANY_PROPS,
                    product: MAPPED_PRODUCT_PROPS,
                };

                if (propMap[entity] && !propMap[entity].includes(propertyName)) {
                    logger.info(`⏩ Propiedad "${propertyName}" no mapeada para ${entity}. Saltando.`);
                    await jobService.markCompleted(_id);
                    return;
                }
            }

            // 2. Echo suppression (HS)
            const echoSuppression = require('../utils/echo.suppression.util');
            if (echoSuppression.wasCreatedInHs(entityId)) {
                logger.info(`♻️ [Echo] Ignorando cambio en HS para ${entity} ID: ${entityId}`);
                await jobService.markCompleted(_id);
                return;
            }

            // 3. Enrutador HS -> QB
            if (entity === 'contact') await contactSyncService.processContact(entityId);
            else if (entity === 'company') await companySyncService.processCompany(entityId);
            else if (entity === 'product') await productSyncService.syncProductToQuickbooks(entityId);
            else if (entity === 'invoice') {
                if (eventType.includes('deal')) {
                    await webhookService.processDealWebhook(entityId);
                } else {
                    await webhookService.processHubSpotInvoiceWebhook(entityId, eventType, payload.propertyName);
                }
            }
            else if (entity === 'line_item') {
                await webhookService.processHubSpotLineItemWebhook(entityId);
            }

        } else if (source === 'QUICKBOOKS') {
            logger.info(`📡 Sincronización QB -> HS: ${entity} ID ${entityId}`);
            
            if (entity === 'contact') {
                await contactSyncService.syncCustomerFromQuickbooks(entityId);
            } else if (entity === 'payment') {
                await paymentSyncService.processQuickbooksPayment(entityId);
            } else if (entity === 'product') {
                await productSyncService.syncProductFromQuickbooks(entityId);
            } else if (entity === 'invoice') {
                await invoiceSyncService.syncInvoiceFromQuickbooks(entityId);
            } else {
                logger.warn(`⚠️ Entidad QB no soportada: ${entity}`);
            }
        }

        await jobService.markCompleted(_id);
        logger.info(`✅ Job [${_id}] completado con éxito.`);

    } catch (error) {
        logger.error(`❌ Job [${_id}] falló por excepción:`, error);
        await jobService.markFailed(_id, error.message);
    }
}

async function startWorker() {
    logger.info('👷 Worker iniciado. Escuchando eventos PENDING...');

    try {
        const pendingJobs = await SyncJob.find({ status: 'PENDING' });
        if (pendingJobs.length > 0) {
            logger.info(`🔄 Encontrados ${pendingJobs.length} jobs pendientes previos.`);
            for (const job of pendingJobs) {
                await mutex.runSequentially(job.entityId, async () => {
                    await processJob(job);
                });
            }
        }

        const changeStream = SyncJob.watch(
            [{ $match: { operationType: 'insert' } }],
            { fullDocument: 'updateLookup' }
        );

        changeStream.on('change', async (change) => {
            const job = change.fullDocument;
            if (!job || job.status !== 'PENDING') return;

            logger.info(`📨 Nuevo job detectado [${job._id}]`);
            
            await mutex.runSequentially(job.entityId, async () => {
                await processJob(job);
            });
        });

        changeStream.on('error', (error) => {
            logger.error('💥 Error en Change Stream de MongoDB:', error);
        });
    } catch (error) {
        logger.error('💥 Error crítico iniciando el Worker:', error);
    }
}

module.exports = { startWorker };