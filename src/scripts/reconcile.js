/**
 * Script de reconciliación de contactos HubSpot ↔ QuickBooks.
 * 
 * Uso:
 *   node src/scripts/reconcile.js --dry-run     → auditoría sin cambios
 *   node src/scripts/reconcile.js --execute      → ejecución real
 * 
 * IMPORTANTE: Desactivar webhooks en HS y QB antes de correr --execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../lib/logger.lib');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('../services/mapping.service');
const authService = require('../services/auth.service');
const { DEFAULT_TENANT_ID } = require('../config/constants');

// ─────────────────────────────────────────────────
// DESCARGA PAGINADA
// ─────────────────────────────────────────────────

/**
 * Descarga TODOS los contactos de HubSpot paginando de a 100.
 * Pide los mismos 11 campos que usa contact.sync.service.js
 */
async function downloadAllHsContacts() {
  const allContacts = [];
  let after = undefined;
  const properties = [
    'email', 'firstname', 'lastname', 'phone',
    'hs_whatsapp_phone_number', 'address', 'city',
    'state', 'zip', 'country', 'id_usuario_quickbooks'
  ].join(',');

  logger.info('[Reconcile] Descargando contactos de HubSpot...');

  do {
    let url = `/crm/v3/objects/contacts?limit=100&properties=${properties}`;
    if (after) url += `&after=${after}`;

    const response = await hubspotClient._getHsClient().get(url);
    allContacts.push(...response.data.results);
    after = response.data.paging?.next?.after;

    if (allContacts.length % 1000 === 0) {
      logger.info(`[Reconcile] HS descargados: ${allContacts.length}...`);
    }
  } while (after);

  logger.info(`[Reconcile] Total contactos HS: ${allContacts.length}`);
  return allContacts;
}

/**
 * Descarga TODOS los customers de QuickBooks paginando de a 1000.
 * QB usa STARTPOSITION y MAXRESULTS en lugar de cursores.
 */
async function downloadAllQbCustomers() {
  const allCustomers = [];
  let startPosition = 1;
  const pageSize = 1000;

  logger.info('[Reconcile] Descargando customers de QuickBooks...');

  const { realmId } = await authService.getQuickBooksConfig(DEFAULT_TENANT_ID);

  while (true) {
    const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`;
    const response = await quickbooksClient.qbClient.get(
      `/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`
    );

    const customers = response.data.QueryResponse.Customer || [];
    allCustomers.push(...customers);

    logger.info(`[Reconcile] QB página: posición ${startPosition}, recibidos ${customers.length}`);

    if (customers.length < pageSize) break;
    startPosition += pageSize;
  }

  logger.info(`[Reconcile] Total customers QB: ${allCustomers.length}`);
  return allCustomers;
}