
require('dotenv').config();

// 1. Validación de variables críticas al arranque (Fail Fast)
const requiredEnvVars = [
  'MONGODB_URI',
  'HUBSPOT_ACCESS_TOKEN', 
  'QB_CLIENT_ID',
  'QB_CLIENT_SECRET',
  'ENCRYPTION_KEY',
  'INTERNAL_API_KEY'
];

for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.error(`[Config] FATAL: Variable de entorno requerida no definida: ${varName}`);
    process.exit(1);
  }
}

// AES-256 exige una llave de exactamente 32 bytes (64 caracteres hex)
if (process.env.ENCRYPTION_KEY.length !== 64) {
  console.error('[Config] FATAL: ENCRYPTION_KEY debe tener exactamente 64 caracteres hex.');
  process.exit(1);
}

// 2. Objeto de configuración centralizado (Híbrido V1 -> V2)
const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    appSecret: process.env.HUBSPOT_APP_SECRET,
  },
  
  quickbooks: {
    // Mantenemos los nombres antiguos por ahora para no romper los services actuales
    baseUrl: process.env.QB_SANDBOX_BASE_URL,
    accessToken: process.env.QB_TEST_ACCESS_TOKEN,
    realmId: process.env.QB_REALM_ID,
    incomeAccountId: process.env.QB_INCOME_ACCOUNT_ID,
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    verifierToken: process.env.QB_WEBHOOK_VERIFIER_TOKEN,
    defaultTaxCodeId: process.env.QB_DEFAULT_TAX_CODE_ID,
  },
  
  mongo: {
    uri: process.env.MONGODB_URI,
  },
  
  security: {
    // Convertimos la llave hex a un Buffer que usa la librería crypto para el AES-256
    encryptionKey: Buffer.from(process.env.ENCRYPTION_KEY, 'hex'),
    internalApiKey: process.env.INTERNAL_API_KEY,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
  },
  
  worker: {
    maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS, 10) || 3,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY, 10) || 3,
  }
};

module.exports = config;