const mongoose = require('mongoose');

const syncJobSchema = new mongoose.Schema({
  source: { 
    type: String, 
    required: true, 
    enum: ['HUBSPOT', 'QUICKBOOKS'] 
  },
  entity: { 
    type: String, 
    required: true 
  },
  entityId: { 
    type: String, 
    required: true 
  },
  eventType: { 
    type: String, 
    required: true 
  },
  payload: { 
    type: mongoose.Schema.Types.Mixed, 
    required: true 
  },
  status: { 
    type: String, 
    required: true, 
    enum: ['PENDING', 'COMPLETED', 'FAILED'], 
    default: 'PENDING' 
  },
  attempts: { 
    type: Number, 
    default: 0 
  },
  lastError: { 
    type: String 
  },
  completedAt: { 
    type: Date 
  }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('SyncJob', syncJobSchema);