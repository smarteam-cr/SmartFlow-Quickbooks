const mongoose = require('mongoose');

const eventDedupSchema = new mongoose.Schema({
  tenantId: { type: String, required: true },
  dedupeKey: { type: String, required: true, unique: true },
  
  // MongoDB borrará automáticamente el documento 300 segundos (5 min) después de creado
  processedAt: { type: Date, default: Date.now, expires: 300 }, 
  
  jobId: { type: mongoose.Schema.Types.ObjectId }
});

module.exports = mongoose.model('EventDedup', eventDedupSchema);