const mongoose = require('mongoose');

const tenantSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  hubspot: {
    accessToken: { type: String }
  },
  quickbooks: {
    realmId: { type: String },
    accessToken: { type: String },
    refreshToken: { type: String },
    tokenExpiresAt: { type: Date },
    refreshTokenExpiresAt: { type: Date }
  }
}, { 
  timestamps: true 
});

module.exports = mongoose.model('Tenant', tenantSchema);