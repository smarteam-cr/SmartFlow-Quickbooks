const SyncJob = require('../db/models/job.model');
const jobService = require('../services/job.service');
const contactSyncService = require('../services/contact.sync.service');
const companySyncService = require('../services/company.sync.service');
const productSyncService = require('../services/product.sync.service');
const invoiceSyncService = require('../services/invoice.sync.service');
const paymentSyncService = require('../services/payment.sync.service');
const webhookService = require('../services/webhook.service');
const mutex = require('../utils/mutex.util');

// Mapeos de propiedades para filtrado (HS)
const MAPPED_CONTACT_PROPS = ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'];
const MAPPED_COMPANY_PROPS = ['name', 'nit', 'phone', 'domain', 'address', 'city', 'country'];
const MAPPED_PRODUCT_PROPS = ['name', 'price', 'hs_price_usd', 'description', 'hs_sku', 'es_gravable'];
const MAPPED_INVOICE_PROPS = ['hs_invoice_date', 'hs_due_date', 'hs_title', 'id_factura_quickbooks', 'estado_de_factura_qb'];
const MAPPED_LINEITEM_PROPS = ['quantity', 'price', 'name', 'description', 'discount', 'es_gravable'];

async function processJob(job) {
    // CAMBIO: Usamos entityId y extraemos source
    const { source, entity, entityId, eventType, payload, _id } = job;

    console.log(`\n⚙️  Procesando Job [${_id}] | Origen: ${source} | Entidad: ${entity}`);

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
                    console.log(`⏩ Propiedad "${propertyName}" no mapeada. Saltando.`);
                    await jobService.markCompleted(_id);
                    return;
                }
            }

            // 2. Echo suppression (HS)
            const echoSuppression = require('../utils/echo.suppression.util');
            if (echoSuppression.wasCreatedInHs(entityId)) {
                console.log(`♻️  [Echo] Ignorando cambio interno en HS para ${entity} ID: ${entityId}`);
                await jobService.markCompleted(_id);
                return;
            }

            // 3. Enrutador HS -> QB
            if (entity === 'contact') await contactSyncService.processContact(entityId);
            else if (entity === 'company') await companySyncService.processCompany(entityId);
            else if (entity === 'product') await productSyncService.syncProductToQuickbooks(entityId);
            else if (entity === 'invoice') {
                if (eventType.includes('deal')) {
                    // Creación inicial desde negocio
                    await webhookService.processDealWebhook(entityId);
                } else {
                    // Actualización de factura propiamente dicha
                    await webhookService.processHubSpotInvoiceWebhook(entityId, eventType, payload.propertyName);
                }
            }
            else if (entity === 'line_item') {
                await webhookService.processHubSpotLineItemWebhook(entityId);
            }

        } else if (source === 'QUICKBOOKS') {
            console.log(`📡 Procesando sincronización QB -> HS para ${entity} ID: ${entityId}`);
            
            // Enrutador de servicios QuickBooks a HubSpot
            if (entity === 'contact') {
                await contactSyncService.syncCustomerFromQuickbooks(entityId);
            } else if (entity === 'payment') {
                await paymentSyncService.processQuickbooksPayment(entityId);
            } else if (entity === 'product') {
                await productSyncService.syncProductFromQuickbooks(entityId);
            } else if (entity === 'invoice') {
                await invoiceSyncService.syncInvoiceFromQuickbooks(entityId);
            } else {
                console.warn(`⚠️ Entidad de QuickBooks no soportada en el Worker: ${entity}`);
            }
        }

        await jobService.markCompleted(_id);
        console.log(`✅ Job [${_id}] completado.`);

    } catch (error) {
        console.error(`❌ Job [${_id}] falló:`, error.message);
        await jobService.markFailed(_id, error.message);
    }
}

async function startWorker() {
    console.log('👷 Worker iniciado. Escuchando eventos PENDING...');

    // 1. Procesar pendientes previos
    const pendingJobs = await SyncJob.find({ status: 'PENDING' });
    if (pendingJobs.length > 0) {
        console.log(`🔄 Encontrados ${pendingJobs.length} jobs pendientes previos.`);
        for (const job of pendingJobs) {
            // CAMBIO: Usar entityId para el mutex
            await mutex.runSequentially(job.entityId, async () => {
                await processJob(job);
            });
        }
    }

    // 2. Escuchar nuevos jobs vía Change Stream
    const changeStream = SyncJob.watch(
        [{ $match: { operationType: 'insert' } }],
        { fullDocument: 'updateLookup' }
    );

    changeStream.on('change', async (change) => {
        const job = change.fullDocument;
        if (!job || job.status !== 'PENDING') return;

        console.log(`\n📨 Nuevo job detectado [${job._id}] — ${job.source} / ${job.entity}`);
        
        // CAMBIO: Usar entityId para el mutex
        await mutex.runSequentially(job.entityId, async () => {
            await processJob(job);
        });
    });

    changeStream.on('error', (error) => {
        console.error('💥 Error en Change Stream:', error.message);
    });
}

module.exports = { startWorker };