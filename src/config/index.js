require('dotenv').config();

const config = {
  port: process.env.PORT || 3000,
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
  },
  quickbooks: {
    baseUrl: process.env.QB_SANDBOX_BASE_URL,
    accessToken: process.env.QB_TEST_ACCESS_TOKEN,
    realmId: process.env.QB_REALM_ID,
    incomeAccountId: process.env.QB_INCOME_ACCOUNT_ID
  },
};

module.exports = config;
