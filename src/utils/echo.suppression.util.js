/**
 * Utilidad en memoria para prevenir Condiciones de Carrera y Webhook Echos.
 * Implementa dos registros separados para manejar la sincronización bidireccional.
 * Hemos ajustado los TTLs para ser asimétricos y mucho más cortos, evitando bloquear
 * cambios manuales legítimos.
 */

const recentlyCreatedInQb = new Set();
const recentlyCreatedInHs = new Set();

// Tiempos de vida asimétricos para la supresión de ecos
const HS_TTL_MS = 10000; // 10 segundos (HubSpot es casi instantáneo)
const QB_TTL_MS = 30000; // 30 segundos (QuickBooks puede demorar un poco más por batching)

// --- Columna QuickBooks ---

function markAsCreatedInQb(qbId) {
    const idString = qbId.toString();
    recentlyCreatedInQb.add(idString);
    
    setTimeout(() => {
        recentlyCreatedInQb.delete(idString);
    }, QB_TTL_MS);
}

function wasCreatedInQb(qbId) {
    return recentlyCreatedInQb.has(qbId.toString());
}

// --- Columna HubSpot ---

function markAsCreatedInHs(hsId) {
    const idString = hsId.toString();
    recentlyCreatedInHs.add(idString);
    
    setTimeout(() => {
        recentlyCreatedInHs.delete(idString);
    }, HS_TTL_MS);
}

function wasCreatedInHs(hsId) {
    if (!hsId) return false;
    return recentlyCreatedInHs.has(hsId.toString());
}


module.exports = {
    markAsCreatedInQb,
    wasCreatedInQb,
    markAsCreatedInHs,
    wasCreatedInHs,
};