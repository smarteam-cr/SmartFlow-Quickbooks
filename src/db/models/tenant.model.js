const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  realmId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  accessToken: { 
    type: String, 
    required: true 
  },
  refreshToken: { 
    type: String, 
    required: true 
  },
  tokenExpiresAt: { 
    type: Date, 
    required: true 
  },
  refreshTokenExpiresAt: { 
    type: Date, 
    required: true 
  }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('Tenant', tenantSchema);