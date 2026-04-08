require('dotenv').config();

const config = {
  port: process.env.PORT || 3000,
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
    appSecret: process.env.HUBSPOT_APP_SECRET,
  },
  quickbooks: {
    baseUrl: process.env.QB_SANDBOX_BASE_URL,
    accessToken: process.env.QB_TEST_ACCESS_TOKEN,
    realmId: process.env.QB_REALM_ID,
    incomeAccountId: process.env.QB_INCOME_ACCOUNT_ID,
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    verifierToken: process.env.QB_WEBHOOK_VERIFIER_TOKEN,
  },
  mongo: {
    uri: process.env.MONGODB_URI,
  },
  
};

module.exports = config;
