/**
 * Utilidad en memoria para prevenir Condiciones de Carrera y Webhook Echos.
 * Implementa dos registros separados para manejar la sincronización bidireccional.
 */

const recentlyCreatedInQb = new Set();
const recentlyCreatedInHs = new Set();

const TTL_MS = 120000; // 2 minutos de tiempo de vida para liberar memoria

// --- Columna QuickBooks ---

function markAsCreatedInQb(qbId) {
    const idString = qbId.toString();
    recentlyCreatedInQb.add(idString);
    
    setTimeout(() => {
        recentlyCreatedInQb.delete(idString);
    }, TTL_MS);
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
    }, TTL_MS);
}

function wasCreatedInHs(hsId) {
    // Si hsId es undefined o null, devolvemos false directamente
    if (!hsId) return false;
    return recentlyCreatedInHs.has(hsId.toString());
}


module.exports = {
    markAsCreatedInQb,
    wasCreatedInQb,
    markAsCreatedInHs,
    wasCreatedInHs,

};