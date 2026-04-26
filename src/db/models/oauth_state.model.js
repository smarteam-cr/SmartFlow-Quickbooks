const mongoose = require('mongoose');

// Almacena los `state` aleatorios emitidos por /auth/quickbooks/connect.
// Permite validar en /auth/quickbooks/callback que el state vino de un flow
// que iniciamos nosotros (protección CSRF) y mapearlo al tenantId real.
// MongoDB borra el documento 600s (10 min) después de creado vía TTL index.
const oauthStateSchema = new mongoose.Schema({
  state: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 },
});

module.exports = mongoose.model('OAuthState', oauthStateSchema);
