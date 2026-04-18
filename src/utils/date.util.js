const logger = require('../lib/logger.lib');

/**
 * Convierte una fecha al formato estricto de QuickBooks (YYYY-MM-DD).
 * 
 * HubSpot envía timestamps en UTC (ej: "2026-04-18T05:59:59.999Z")
 * que representan "fin del día" en la zona horaria del cliente.
 * Sin el offset, el servidor interpreta la fecha en UTC y puede sumar un día.
 * 
 * @param {string|Date} dateInput - Fecha desde HubSpot (ISO string o Date)
 * @param {number} utcOffsetMs - Offset en milisegundos del tenant (ej: -21600000 para UTC-6)
 */
const formatToQbDate = (dateInput, utcOffsetMs = 0) => {
  if (!dateInput) return undefined;

  const dateObj = new Date(dateInput);
  if (isNaN(dateObj.getTime())) return undefined;

  // Aplicar el offset del tenant para obtener la fecha en su zona horaria real.
  // Ej: "2026-04-18T05:59:59.999Z" + (-21600000ms) = "2026-04-17T23:59:59.999" = día 17 (correcto)
  const adjustedTime = dateObj.getTime() + utcOffsetMs;
  const adjustedDate = new Date(adjustedTime);

  const year = adjustedDate.getUTCFullYear();
  const month = String(adjustedDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(adjustedDate.getUTCDate()).padStart(2, '0');

  const formattedDate = `${year}-${month}-${day}`;

  logger.info(`[DateUtil] Input: ${dateInput} | Offset: ${utcOffsetMs}ms | Output: ${formattedDate}`);
  return formattedDate;
};

module.exports = { formatToQbDate };