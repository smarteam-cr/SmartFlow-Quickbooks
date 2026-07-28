const capitalizeTitleCase = (input) => {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\s+/)
    .map(word => word.length === 0 ? '' : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

module.exports = { capitalizeTitleCase };