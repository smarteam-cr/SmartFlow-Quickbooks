const mongoose = require('mongoose');
const SyncJob = require('../db/models/job.model');
const jobService = require('../services/job.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const webhookService = require('../services/webhook.service');
const mutex = require('../utils/mutex.util');

const MAPPED_CONTACT_PROPS = ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'];
const MAPPED_COMPANY_PROPS = ['name', 'nit', 'phone', 'domain', 'address', 'city', 'country'];
const MAPPED_PRODUCT_PROPS = ['name', 'price', 'hs_price_usd', 'description', 'hs_sku', 'es_gravable'];

async function processJob(job) {
    const { entity, hsObjectId, eventType, payload } = job;

    console.log(`\n🔧 Ejecutando processJob para [${job._id}] entity: ${entity} eventType: ${eventType}`);

    try {
        if (eventType.includes('propertyChange')) {
            const propertyName = payload.propertyName;
            console.log(`🔍 propertyName detectado: ${propertyName}`);

            const propMap = {
                contact: MAPPED_CONTACT_PROPS,
                company: MAPPED_COMPANY_PROPS,
                product: MAPPED_PRODUCT_PROPS,
            };

            if (propMap[entity] && !propMap[entity].includes(propertyName)) {
                console.log(`⏩ Propiedad "${propertyName}" no mapeada. Saltando.`);
                await jobService.markCompleted(job._id);
                return;
            }
        }

        console.log(`🚀 Pasó filtros. Ejecutando servicio para ${entity}...`);

        // Echo suppression — ignoramos cambios que generamos nosotros mismos
        const echoSuppression = require('../utils/echo.suppression.util');
        if (echoSuppression.wasCreatedInHs(hsObjectId)) {
            console.log(`♻️ [Echo] Ignorando ${entity} ${hsObjectId} (cambio interno).`);
            await jobService.markCompleted(job._id);
            return;
        }

        // Enrutador principal
        if (entity === 'contact') {
            await contactSyncService.processContact(hsObjectId);
        } else if (entity === 'company') {
            await companySyncService.processCompany(hsObjectId);
        } else if (entity === 'product') {
            await productSyncService.syncProductToQuickbooks(hsObjectId);
        } else if (entity === 'invoice') {
            await webhookService.processDealWebhook(hsObjectId);
        }

        await jobService.markCompleted(job._id);
        console.log(`✅ Job [${job._id}] completado para ${entity} ID: ${hsObjectId}`);

    } catch (error) {
        console.error(`❌ Job [${job._id}] falló para ${entity} ID: ${hsObjectId}:`);
        console.error(error);
    }
}

async function startWorker() {
    console.log('👷 Worker iniciado. Escuchando eventos PENDING...');

    // Primero procesamos jobs PENDING que quedaron de antes (por si el servidor se reinició)
    const pendingJobs = await SyncJob.find({ status: 'PENDING' });
    if (pendingJobs.length > 0) {
        console.log(`🔄 Encontrados ${pendingJobs.length} jobs PENDING previos. Procesando...`);
        for (const job of pendingJobs) {
            await mutex.runSequentially(job.hsObjectId, async () => {
                await processJob(job);
            });
        }
    }

    // Luego nos suscribimos a nuevos eventos via Change Streams
    const changeStream = SyncJob.watch(
        [{ $match: { operationType: 'insert' } }],
        { fullDocument: 'updateLookup' }
    );

    changeStream.on('change', async (change) => {
        const job = change.fullDocument;

        if (!job || job.status !== 'PENDING') return;

        console.log(`\n📨 Nuevo job detectado [${job._id}] — ${job.entity} / ${job.eventType}`);
        await mutex.runSequentially(job.hsObjectId, async () => {
            await processJob(job);
        });
    });

    changeStream.on('error', (error) => {
        console.error('💥 Error en Change Stream:', error.message);
    });
}

module.exports = { startWorker };