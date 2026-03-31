/**
 * Convierte una fecha (string o timestamp) al formato estricto de QuickBooks (YYYY-MM-DD)
 * @param {string|number} dateInput - Fecha original
 * @returns {string|undefined} Fecha formateada o undefined si es inválida
 */
const formatToQbDate = (dateInput) => {
  if (!dateInput) return undefined;
  
  const dateObj = new Date(dateInput);
  if (isNaN(dateObj.getTime())) return undefined; 
  
  return dateObj.toISOString().split('T')[0]; 
};

module.exports = { formatToQbDate };