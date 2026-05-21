#!/usr/bin/env node
/**
 * Migración V2 QB → HS — solo enlace, sin creación de contactos.
 *
 * Misma lógica que migrate-qb-contacts.js pero con una diferencia clave:
 * si el email del QB customer NO existe en HubSpot, se SKIPEA en lugar de
 * crear un contacto nuevo. Esto garantiza cero contactos fantasma en HS.
 *
 * Flujo por customer elegible:
 *   1. Validaciones de elegibilidad (CompanyName, email, Notes).
 *   2. Si ya tiene EntityMapping → skip (already_mapped).
 *   3. Busca email en HS:
 *      - Encontrado → enlaza (actualiza HS + reestructura QB + crea mapping).
 *      - No encontrado → skip (not_found_in_hs), QB no se toca.
 *
 * Uso:
 *   node src/scripts/v2-migrate-contacts-qb.js [--limit=N] [--dry-run]
 *
 * Precondiciones: mismas que migrate-qb-contacts.js (ver ROADMAP paso 5.1).
 */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../db/database');
const authService = require('../services/auth.service');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('../services/mapping.service');
const { DEFAULT_TENANT_ID, CONTACT_STATUS_PROPERTY, CONTACT_STATUS_VALUES } = require('../config/constants');

const tenantId = DEFAULT_TENANT_ID;
const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const DRY_RUN = args.includes('--dry-run');
const THROTTLE_MS = 500;

const SUPPORTED_HS_CURRENCIES = new Set(['USD', 'CRC']);
const RETRY_MAX = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Wrapper de retry con backoff exponencial para llamadas a APIs externas.
 * Reintenta en 429 (rate limit), 5xx (errores de servidor) y errores de red.
 */
async function withRetry(fn, label, maxAttempts = RETRY_MAX) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const retryable = [429, 500, 502, 503, 504].includes(status)
        || ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(err.code);

      if (!retryable || attempt === maxAttempts - 1) throw err;

      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      console.warn(`     ⏳ ${label}: HTTP ${status || err.code}, reintento en ${Math.round(delay / 1000)}s (${attempt + 1}/${maxAttempts})`);
      await sleep(delay);
    }
  }
}

function md5(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

function csvField(val) {
  return `"${String(val || '').replace(/"/g, '""')}"`;
}

function generateCsv(report) {
  const header = 'qbId;companyName;email;notes;motivo_skip';
  const rows = [];
  for (const r of report.skippedNoEmail) {
    rows.push([csvField(r.qbId), csvField(r.companyName), '', '', 'sin_email'].join(';'));
  }
  for (const r of report.skippedDuplicateEmail) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), '', 'email_duplicado'].join(';'));
  }
  for (const r of report.skippedNoNotes) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), '', 'sin_notes'].join(';'));
  }
  for (const r of report.skippedInvalidNotes) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), csvField(r.notes), 'notes_invalido'].join(';'));
  }
  for (const r of report.skippedDuplicateNotes) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), csvField(r.notes), 'notes_duplicado'].join(';'));
  }
  for (const r of report.skippedNotInHs) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), csvField(r.notes), 'no_existe_en_hs'].join(';'));
  }
  for (const r of report.unsupportedCurrency) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), '', csvField(`moneda_no_soportada:${r.qbCurrency}`)].join(';'));
  }
  for (const r of report.failed) {
    rows.push([csvField(r.qbId), csvField(r.companyName), csvField(r.email), '', csvField(`error: ${r.error || ''}`)].join(';'));
  }
  return [header, ...rows].join('\n');
}

function isEligibleCustomer(c) {
  const hasCompanyName = !!(c.CompanyName && c.CompanyName.trim());
  const noGivenName = !c.GivenName || !c.GivenName.trim();
  const noFamilyName = !c.FamilyName || !c.FamilyName.trim();
  return hasCompanyName && noGivenName && noFamilyName;
}

async function fetchAllQbCustomers() {
  const { qbClient } = quickbooksClient;
  const { realmId } = await authService.getQuickBooksConfig(tenantId);
  const baseUrl = `/${realmId}`;
  const pageSize = 1000;
  let start = 1;
  const all = [];

  while (true) {
    const query = `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const customers = response.data.QueryResponse.Customer || [];
    all.push(...customers);
    console.log(`   ...cargados ${all.length} customers`);
    if (customers.length < pageSize) break;
    start += pageSize;
    await sleep(300);
  }
  return all;
}

async function updateQbForMigration(customer, givenName, suffix) {
  const { qbClient } = quickbooksClient;
  const { realmId } = await authService.getQuickBooksConfig(tenantId);
  const displayName = `${givenName} ${suffix}`.trim();

  const payload = {
    Id: String(customer.Id),
    SyncToken: String(customer.SyncToken),
    sparse: true,
    GivenName: givenName,
    FamilyName: '',
    Suffix: suffix,
    CompanyName: '',
    DisplayName: displayName
  };

  try {
    const response = await qbClient.post(`/${realmId}/customer?minorversion=65`, payload);
    return response.data.Customer;
  } catch (err) {
    const detail = err.response?.data?.Fault?.Error?.[0]?.Message || err.message;
    throw new Error(detail);
  }
}

function resolveQbCurrencyForHs(customer) {
  const qbCurrency = (customer.CurrencyRef?.value || '').trim();
  if (!qbCurrency) return { value: '', supported: true, raw: '' };
  if (SUPPORTED_HS_CURRENCIES.has(qbCurrency)) return { value: qbCurrency, supported: true, raw: qbCurrency };
  return { value: '', supported: false, raw: qbCurrency };
}

/**
 * Debe coincidir EXACTAMENTE con el hash de syncCustomerFromQuickbooks
 * (contact.sync.service.js ~línea 297-308) para que el primer webhook
 * post-migración haga hash-match y no dispare un update innecesario.
 *
 * Campos críticos que difieren del V1:
 *   - estado_del_contacto_qb: incluido (el sync normal lo incluye)
 *   - moneda_de_preferencia: usa CurrencyRef.value raw, NO el filtrado por
 *     SUPPORTED_HS_CURRENCIES (el sync normal usa el valor directo de QB)
 */
function buildHashForMapping(customer, givenName, suffix) {
  const hsProps = {
    firstname: givenName,
    lastname: '',
    email: customer.PrimaryEmailAddr?.Address || '',
    phone: customer.PrimaryPhone?.FreeFormNumber || '',
    hs_whatsapp_phone_number: customer.Mobile?.FreeFormNumber || '',
    address: customer.BillAddr?.Line1 || '',
    city: customer.BillAddr?.City || '',
    state: customer.BillAddr?.CountrySubDivisionCode || '',
    zip: customer.BillAddr?.PostalCode || '',
    country: customer.BillAddr?.Country || '',
    documento_de_identidad: suffix,
    moneda_de_preferencia: customer.CurrencyRef?.value || '',
    [CONTACT_STATUS_PROPERTY]: customer.Active === false
      ? CONTACT_STATUS_VALUES.INACTIVE
      : CONTACT_STATUS_VALUES.ACTIVE,
  };
  return md5({ ...hsProps, _parentRef: customer.ParentRef?.value || null });
}

async function processCustomer(customer) {
  const qbId = String(customer.Id);
  const rawEmail = customer.PrimaryEmailAddr?.Address || '';
  const email = rawEmail.trim();
  const suffix = (customer.Notes || '').trim();
  const companyName = customer.CompanyName.trim();
  const currency = resolveQbCurrencyForHs(customer);

  // ── Checkpoint 1: ¿ya tiene mapping? ──
  const existingMapping = await mappingService.findByQbId(tenantId, 'contact', qbId);
  if (existingMapping) {
    return { qbId, status: 'already_mapped', hsContactId: existingMapping.hsId };
  }

  // ── Checkpoint 2: buscar contacto en HS por email ──
  const hsContact = await withRetry(
    () => hubspotClient.searchContactByEmail(normalizeEmail(email)),
    `searchEmail QB ${qbId}`
  );

  if (DRY_RUN) {
    return {
      qbId, email, suffix, companyName,
      qbCurrency: currency.raw,
      currencySupported: currency.supported,
      status: hsContact ? 'would_link' : 'would_skip_not_in_hs',
      hsContactId: hsContact?.id || null
    };
  }

  // ── Si no existe en HS → skip, no se toca QB ──
  if (!hsContact) {
    return {
      qbId, email, suffix, companyName,
      qbCurrency: currency.raw,
      currencySupported: currency.supported,
      status: 'not_found_in_hs',
      hsContactId: null
    };
  }

  // ── Existe en HS → enlazar ──
  if (!currency.supported) {
    console.warn(`     ⚠️  QB ${qbId} tiene CurrencyRef="${currency.raw}" no soportada por HS (solo USD/CRC). Se omite moneda_de_preferencia.`);
  }

  const currencyField = currency.value ? { moneda_de_preferencia: currency.value } : {};
  const hsContactId = hsContact.id;

  // Actualizar HS: setear id_usuario_quickbooks + campos del customer QB
  await withRetry(
    () => hubspotClient.updateContactProperty(hsContactId, qbId),
    `updateProp HS ${hsContactId}`
  );
  await withRetry(
    () => hubspotClient.updateContact(hsContactId, {
      firstname: companyName,
      lastname: '',
      documento_de_identidad: suffix,
      phone: customer.PrimaryPhone?.FreeFormNumber || '',
      hs_whatsapp_phone_number: customer.Mobile?.FreeFormNumber || '',
      address: customer.BillAddr?.Line1 || '',
      city: customer.BillAddr?.City || '',
      state: customer.BillAddr?.CountrySubDivisionCode || '',
      zip: customer.BillAddr?.PostalCode || '',
      country: customer.BillAddr?.Country || '',
      ...currencyField,
    }),
    `updateContact HS ${hsContactId}`
  );

  // Reestructurar QB: CompanyName → GivenName, Notes → Suffix
  const updatedQb = await withRetry(
    () => updateQbForMigration(customer, companyName, suffix),
    `updateQB ${qbId}`
  );

  // Crear EntityMapping con hash post-migración
  const payloadHash = buildHashForMapping(customer, companyName, suffix);
  await mappingService.upsertMapping({
    tenantId,
    entityType: 'contact',
    hsId: hsContactId,
    qbId: qbId,
    qbSyncToken: updatedQb.SyncToken,
    payloadHash,
    sourceSystem: 'QUICKBOOKS'
  });

  return {
    qbId, email, companyName, hsContactId,
    qbCurrency: currency.raw,
    currencySupported: currency.supported,
    status: 'linked_existing'
  };
}

async function run() {
  console.log('============================================================');
  console.log('  Migración V2 QB → HS (solo enlace, sin creación)');
  console.log(`  Modo:    ${DRY_RUN ? 'DRY-RUN (simulación, sin cambios)' : 'EJECUCIÓN REAL'}`);
  console.log(`  Límite:  ${LIMIT ?? 'sin límite'}`);
  console.log(`  Tenant:  ${tenantId}`);
  console.log('============================================================\n');

  console.log('📡 Conectando a MongoDB...');
  await connectDB();

  console.log('📡 Cargando customers de QuickBooks (paginado)...');
  const allCustomers = await fetchAllQbCustomers();
  console.log(`   Total activos en QB: ${allCustomers.length}\n`);

  console.log('🔍 Filtrando cohort legacy (CompanyName sin GivenName/FamilyName)...');
  const eligible = allCustomers.filter(isEligibleCustomer);
  console.log(`   Elegibles para migración: ${eligible.length}\n`);

  // Pre-cómputo de frecuencias sobre TODOS los customers activos
  const emailCount = new Map();
  const notesCount = new Map();
  for (const c of allCustomers) {
    const e = normalizeEmail(c.PrimaryEmailAddr?.Address);
    if (e) emailCount.set(e, (emailCount.get(e) || 0) + 1);
    const n = (c.Notes || '').trim();
    if (n) notesCount.set(n, (notesCount.get(n) || 0) + 1);
  }
  const emailDupes = [...emailCount.entries()].filter(([, n]) => n > 1).length;
  const notesDupes = [...notesCount.entries()].filter(([, n]) => n > 1).length;
  console.log(`   Emails duplicados en QB (todos): ${emailDupes}`);
  console.log(`   Notes duplicados en QB (todos):  ${notesDupes}\n`);

  const report = {
    startedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'real',
    limit: LIMIT,
    totalQbCustomers: allCustomers.length,
    totalEligible: eligible.length,
    migrated: [],
    alreadyMapped: [],
    skippedNoEmail: [],
    skippedDuplicateEmail: [],
    skippedNoNotes: [],
    skippedInvalidNotes: [],
    skippedDuplicateNotes: [],
    skippedNotInHs: [],
    unsupportedCurrency: [],
    failed: []
  };

  let processed = 0;
  for (const customer of eligible) {
    if (LIMIT && report.migrated.length >= LIMIT) {
      console.log(`\n⏸️  Límite de ${LIMIT} alcanzado. Deteniendo.`);
      break;
    }

    processed++;
    const email = normalizeEmail(customer.PrimaryEmailAddr?.Address);
    const label = `QB ${customer.Id} | ${(customer.CompanyName || '').slice(0, 40)}`;

    // ── Validación 1: email presente ──
    if (!email) {
      report.skippedNoEmail.push({ qbId: customer.Id, companyName: customer.CompanyName });
      console.log(`  [${processed}] ⚠️  sin email          → ${label}`);
      continue;
    }

    // ── Validación 2: email único en QB ──
    if ((emailCount.get(email) || 0) > 1) {
      report.skippedDuplicateEmail.push({ qbId: customer.Id, companyName: customer.CompanyName, email });
      console.log(`  [${processed}] ⚠️  email duplicado    → ${label}`);
      continue;
    }

    // ── Validación 3: Notes presente ──
    const notes = (customer.Notes || '').trim();
    if (!notes) {
      report.skippedNoNotes.push({ qbId: customer.Id, companyName: customer.CompanyName, email });
      console.log(`  [${processed}] ⚠️  sin notes          → ${label}`);
      continue;
    }

    // ── Validación 4: Notes empieza con dígito y ≤16 chars ──
    if (!/^\d/.test(notes) || notes.length > 16) {
      report.skippedInvalidNotes.push({ qbId: customer.Id, companyName: customer.CompanyName, email, notes });
      console.log(`  [${processed}] ⚠️  notes inválido     → ${label} (${notes})`);
      continue;
    }

    // ── Validación 5: Notes único en QB ──
    if ((notesCount.get(notes) || 0) > 1) {
      report.skippedDuplicateNotes.push({ qbId: customer.Id, companyName: customer.CompanyName, email, notes });
      console.log(`  [${processed}] ⚠️  notes duplicado    → ${label} (${notes})`);
      continue;
    }

    try {
      const result = await processCustomer(customer);

      // Moneda no soportada (informativo, no bloquea)
      if (result.currencySupported === false) {
        report.unsupportedCurrency.push({
          qbId: result.qbId, companyName: customer.CompanyName,
          email, qbCurrency: result.qbCurrency
        });
      }

      if (result.status === 'already_mapped') {
        report.alreadyMapped.push(result);
        console.log(`  [${processed}] ⏩  ya enlazado        → ${label}`);

      } else if (result.status === 'not_found_in_hs') {
        report.skippedNotInHs.push({ qbId: result.qbId, companyName: customer.CompanyName, email, notes });
        console.log(`  [${processed}] 🔍 no existe en HS    → ${label}`);

      } else if (result.status === 'would_link') {
        report.migrated.push(result);
        console.log(`  [${processed}] 🔵 [DRY] would_link   → ${label} → HS ${result.hsContactId}`);

      } else if (result.status === 'would_skip_not_in_hs') {
        report.skippedNotInHs.push({ qbId: result.qbId, companyName: customer.CompanyName, email, notes });
        console.log(`  [${processed}] 🔵 [DRY] no en HS     → ${label}`);

      } else if (result.status === 'linked_existing') {
        report.migrated.push(result);
        console.log(`  [${processed}] ✅ linked_existing     → ${label} → HS ${result.hsContactId}`);
      }
    } catch (err) {
      report.failed.push({
        qbId: customer.Id, companyName: customer.CompanyName,
        email, error: err.message
      });
      console.log(`  [${processed}] ❌ falló              → ${label} — ${err.message}`);
    }

    await sleep(THROTTLE_MS);
  }

  report.finishedAt = new Date().toISOString();

  console.log('\n============================================================');
  console.log('  REPORTE FINAL');
  console.log('============================================================');
  console.log(`  ✅ Enlazados OK:               ${report.migrated.length}`);
  console.log(`  ⏩ Ya enlazados (skip):        ${report.alreadyMapped.length}`);
  console.log(`  🔍 No existe en HS (skip):     ${report.skippedNotInHs.length}`);
  console.log(`  ⚠️  Sin email (skip):           ${report.skippedNoEmail.length}`);
  console.log(`  ⚠️  Email duplicado (skip):     ${report.skippedDuplicateEmail.length}`);
  console.log(`  ⚠️  Sin notes (skip):           ${report.skippedNoNotes.length}`);
  console.log(`  ⚠️  Notes inválido (skip):      ${report.skippedInvalidNotes.length}`);
  console.log(`  ⚠️  Notes duplicado (skip):     ${report.skippedDuplicateNotes.length}`);
  console.log(`  ⚠️  Moneda no soportada:        ${report.unsupportedCurrency.length}`);
  console.log(`  ❌ Fallidos:                   ${report.failed.length}`);
  console.log('============================================================\n');

  const reportDir = path.join(process.cwd(), 'migration-reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const fileTs = Date.now();
  const fileSuffix = DRY_RUN ? '-dryrun' : '';
  const reportFile = path.join(reportDir, `v2-migration-${fileTs}${fileSuffix}.json`);
  const csvFile = path.join(reportDir, `v2-migration-${fileTs}${fileSuffix}.csv`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(csvFile, generateCsv(report));
  console.log(`📄 Reporte JSON: ${reportFile}`);
  console.log(`📄 Reporte CSV:  ${csvFile}\n`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('💥 Error crítico:', err.message);
  console.error(err.stack);
  process.exit(1);
});
