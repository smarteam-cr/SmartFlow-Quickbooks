/**
 * Calcula la próxima fecha de reintento con backoff exponencial y jitter.
 * Fórmula: 2^attempts * 1000ms + (0 a 1000ms de ruido aleatorio)
 */
function calculateNextRetry(attempts, jitter = true) {
  const base = Math.pow(2, attempts) * 1000;
  const noise = jitter ? Math.random() * 1000 : 0;
  return new Date(Date.now() + base + noise);
}

/**
 * Determina si un error amerita reintento según su código HTTP o de sistema.
 */
function isRetryableError(error) {
  const status = error.response?.status;
  
  // Reintentables: Rate limit (429), Conflictos temporales (409) o Errores de Servidor (5xx)
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
  
  // Errores de red a nivel de Node.js (Caída de conexión, DNS)
  if (['ECONNABORTED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) return true;
  
  // No reintentables: Bad Request (400), No Autorizado (401), Prohibido (403), No Encontrado (404), Validación (422)
  if ([400, 401, 403, 404, 422].includes(status)) return false;
  
  // Por defecto, asumimos que es un error temporal
  return true; 
}

module.exports = { calculateNextRetry, isRetryableError };