const mongoose = require('mongoose');

// NOTA: Los campos *Encrypted almacenan strings Base64 resultado de crypto.lib.js
const tenantSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true, index: true },
  name: { type: String },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  
  hubspot: {
    portalId: { type: String },
    accessTokenEncrypted: { type: String },
    utcOffset: { type: String },              // Ej: "-06:00" — referencia legible
    utcOffsetMilliseconds: { type: Number },  // Ej: -21600000 — para cálculos de fecha
  },
  
  quickbooks: {
    realmId: { type: String },
    accessTokenEncrypted: { type: String }, 
    refreshTokenEncrypted: { type: String }, 
    tokenExpiresAt: { type: Date },
    refreshTokenExpiresAt: { type: Date },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' }
  },
  
  // Preferencias operativas del tenant
  preferences: {
    // Mapeo entre internal values del dropdown de tax en HS (hs_tax_rate_group_id)
    // y los TaxCode IDs de QB. Se configura vía src/scripts/configure-tax-mappings.js.
    taxMappings: { type: Map, of: String }
  }
}, { timestamps: true });

module.exports = mongoose.model('Tenant', tenantSchema);