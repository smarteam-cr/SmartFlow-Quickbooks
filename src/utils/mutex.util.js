/**
 * Mutex (Mutual Exclusion) en Memoria
 * Garantiza que los eventos para un mismo ID se procesen de forma secuencial (uno tras otro)
 * en lugar de ejecutarse en paralelo, evitando el "Stale Object Error" en QuickBooks.
 */
const locks = new Map();

async function runSequentially(id, taskFunction) {
    const idStr = id.toString();

    // 1. Obtenemos el candado actual (si existe)
    const previousTask = locks.get(idStr) || Promise.resolve();

    // 2. Creamos la nueva tarea encadenada
    const currentTask = (async () => {
        try {
            // Esperamos a que la tarea anterior termine (sin importar si falló)
            await previousTask.catch(() => {});
            // Ejecutamos la tarea actual y RETORNAMOS su valor
            return await taskFunction();
        } catch (error) {
            console.error(`❌ Error en tarea secuencial para ID ${idStr}:`, error.message);
            throw error; // Re-lanzamos para que el llamador sepa que falló
        } finally {
            // 3. Limpieza: Si somos la última tarea en la fila, quitamos el candado
            if (locks.get(idStr) === currentTask) {
                locks.delete(idStr);
            }
        }
    })();

    // 4. Actualizamos el mapa de candados
    locks.set(idStr, currentTask);

    return currentTask;
}

module.exports = { runSequentially };