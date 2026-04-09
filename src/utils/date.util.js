const logger = require('../lib/logger.lib');

/**
 * Convierte una fecha al formato estricto de QuickBooks (YYYY-MM-DD)
 * Extrae los componentes locales para evitar que el desfase UTC sume un día.
 */
const formatToQbDate = (dateInput) => {
  if (!dateInput) return undefined;

  const dateObj = new Date(dateInput);
  if (isNaN(dateObj.getTime())) return undefined;

  // Extraemos año, mes y día basándonos en la fecha "tal cual" la ve el servidor
  // sin convertirla a ISO/UTC.
  const year = dateObj.getFullYear();
  // Los meses en JS van de 0 a 11, sumamos 1. padStart asegura el formato 01, 02...
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');

  const formattedDate = `${year}-${month}-${day}`;

  logger.info(`[DateUtil] Input: ${dateInput} -> Output: ${formattedDate}`);
  return formattedDate;
};

module.exports = { formatToQbDate };