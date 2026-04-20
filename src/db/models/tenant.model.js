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
  
  // Preferencias operativas descubiertas automáticamente vía QB API durante OAuth
  preferences: {
    incomeAccountId: { type: String },       // ID de la cuenta de ingresos en QB
    defaultTaxCodeId: { type: String },      // ID del TaxCode en QB (el del dropdown)
    defaultTaxRateId: { type: String },      // ID del TaxRate dentro de ese TaxCode
    defaultTaxRatePercent: { type: Number }, // Porcentaje (ej: 13)
    taxMappings: { type: Map, of: String }
  }
}, { timestamps: true });

module.exports = mongoose.model('Tenant', tenantSchema);