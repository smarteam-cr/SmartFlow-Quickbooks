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
  
  // Preferencias operativas descubiertas vía OAuth o configuradas en onboarding
  preferences: {
    incomeAccountId: { type: String },
    defaultTaxCodeId: { type: String },
    // Mapa flexible para cruzar IDs de impuestos de HS hacia QB. Ej: { "hs_tax_19": "qb_code_3" }
    taxMappings: { type: Map, of: String }
  }
}, { timestamps: true });

module.exports = mongoose.model('Tenant', tenantSchema);