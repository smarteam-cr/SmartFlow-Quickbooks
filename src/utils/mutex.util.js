/**
 * Mutex (Mutual Exclusion) en Memoria
 * Garantiza que los eventos para un mismo ID se procesen de forma secuencial (uno tras otro)
 * en lugar de ejecutarse en paralelo, evitando el "Stale Object Error" en QuickBooks.
 */
const locks = new Map();

async function runSequentially(id, taskFunction) {
    const idStr = id.toString();

    // 1. Obtenemos la promesa anterior para este ID (si hay alguien en la fila)
    // Si no hay nadie, creamos una promesa resuelta para empezar de inmediato.
    const previousTask = locks.get(idStr) || Promise.resolve();

    // 2. Encadenamos la nueva tarea para que espere a que termine la anterior
    const nextTask = previousTask.then(async () => {
        try {
            await taskFunction();
        } catch (error) {
            console.error(`❌ Error en tarea secuencial para ID ${idStr}:`, error.message);
        }
    });

    // 3. Actualizamos el candado para que el próximo que llegue espere a esta nueva tarea
    locks.set(idStr, nextTask);

    // 4. Limpieza: Cuando esta tarea termine, si ya no hay nadie más en la fila, quitamos el candado
    nextTask.finally(() => {
        if (locks.get(idStr) === nextTask) {
            locks.delete(idStr);
        }
    });

    return nextTask;
}

module.exports = { runSequentially };