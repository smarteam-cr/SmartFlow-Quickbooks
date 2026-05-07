/**
 * Utilidad compartida para extraer el detalle legible de errores de Axios.
 * Soporta los formatos de error de QuickBooks (Fault.Error) y HubSpot (message/errors).
 * Nunca devuelve un objeto no serializable.
 */
function extractAxiosError(error) {
  if (!error) return 'Unknown error';

  const data = error.response && error.response.data;
  if (data) {
    // Formato QuickBooks
    if (data.Fault && Array.isArray(data.Fault.Error) && data.Fault.Error.length > 0) {
      const fault = data.Fault.Error[0];
      const detail = fault.Detail || fault.Message || '';
      const code = fault.code ? ` (code=${fault.code})` : '';
      const headers = error.response.headers || {};
      const tid = headers['intuit_tid'] || headers['intuit-tid'];
      const tidStr = tid ? ` [intuit_tid=${tid}]` : '';
      if (detail) return `${detail}${code}${tidStr}`;
    }

    // Formato HubSpot estándar
    if (typeof data.message === 'string') {
      const category = data.category ? ` [${data.category}]` : '';
      const context = data.context ? ` ${safeStringify(data.context)}` : '';
      return `${data.message}${category}${context}`;
    }
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      return data.errors.map(e => e.message || safeStringify(e)).join(' | ');
    }

    // Fallback: body crudo
    return safeStringify(data);
  }

  return error.message || 'Unknown error';
}

function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

module.exports = { extractAxiosError, safeStringify };
