#!/usr/bin/env node
/**
 * Migración one-shot QB → HS para el cohort legacy de contactos.
 * Procesa QB customers con `CompanyName` poblado pero sin `GivenName`/`FamilyName`:
 * los enlaza al contacto HS correspondiente (por email) o los crea en HS, y
 * reestructura el QB customer para que el sync normal los reconozca como
 * personas en adelante (GivenName = CompanyName, Suffix = email, CompanyName limpio).
 *
 * Uso:
 *   node src/scripts/migrate-qb-contacts.js [--limit=N] [--dry-run]
 *
 * Precondiciones antes de ejecutar:
 *   1. Borrar jobs pendientes: db.syncjobs.deleteMany({ status: { $in: ["PENDING","RETRY_PENDING"] } })
 *   2. Pausar el worker (comentar await startWorker() en src/server.js y reiniciar)
 *   3. Desactivar webhooks en HubSpot y QuickBooks (o instruir al equipo que no toque QB)
 *   4. Hacer backup de la colección entitymappings en MongoDB
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
const { DEFAULT_TENANT_ID } = require('../config/constants');

const tenantId = DEFAULT_TENANT_ID;
const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find(x => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();
const DRY_RUN = args.includes('--dry-run');
const THROTTLE_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function buildHashForMapping(customer, givenName, suffixEmail) {
  // Debe coincidir con el hash que syncCustomerFromQuickbooks calcularía después
  // de la migración, para que el primer webhook post-migración haga hash-match.
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
    documento_de_identidad: suffixEmail,
  };
  return md5({ ...hsProps, _parentRef: customer.ParentRef?.value || null });
}

async function processCustomer(customer) {
  const qbId = String(customer.Id);
  const rawEmail = customer.PrimaryEmailAddr?.Address || '';
  const email = rawEmail.trim();
  const suffix = normalizeEmail(email).slice(0, 16); // QB Suffix max 16 chars
  const companyName = customer.CompanyName.trim();

  const existingMapping = await mappingService.findByQbId(tenantId, 'contact', qbId);
  if (existingMapping) {
    return { qbId, status: 'already_mapped', hsContactId: existingMapping.hsId };
  }

  if (DRY_RUN) {
    const found = await hubspotClient.searchContactByEmail(normalizeEmail(email));
    return {
      qbId, email, suffix, companyName,
      status: found ? 'would_link' : 'would_create',
      hsContactId: found?.id || null
    };
  }

  // 1. Resolver contacto en HS (link o create)
  const hsContact = await hubspotClient.searchContactByEmail(normalizeEmail(email));
  let hsContactId;
  let hsStatus;

  if (hsContact) {
    hsContactId = hsContact.id;
    await hubspotClient.updateContactProperty(hsContactId, qbId);
    await hubspotClient.updateContact(hsContactId, {
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
    });
    hsStatus = 'linked_existing';
  } else {
    const hsProps = {
      firstname: companyName,
      lastname: '',
      email: email,
      documento_de_identidad: suffix,
      phone: customer.PrimaryPhone?.FreeFormNumber || '',
      hs_whatsapp_phone_number: customer.Mobile?.FreeFormNumber || '',
      address: customer.BillAddr?.Line1 || '',
      city: customer.BillAddr?.City || '',
      state: customer.BillAddr?.CountrySubDivisionCode || '',
      zip: customer.BillAddr?.PostalCode || '',
      country: customer.BillAddr?.Country || '',
    };
    const newContact = await hubspotClient.createSingleContact(hsProps, qbId);
    hsContactId = newContact.id;
    hsStatus = 'created_new';
  }

  // 2. Actualizar QB: CompanyName → GivenName, Suffix = primeros 16 chars del email, CompanyName limpio
  const updatedQb = await updateQbForMigration(customer, companyName, suffix);

  // 3. EntityMapping con hash del estado post-migración
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

  return { qbId, email, companyName, hsContactId, status: hsStatus };
}

async function run() {
  console.log('============================================================');
  console.log(`  Migración QB → HS (contactos legacy con CompanyName)`);
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

  // Pre-cómputo de frecuencias sobre TODOS los customers activos (no solo el cohort elegible)
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

    if (!email) {
      report.skippedNoEmail.push({ qbId: customer.Id, companyName: customer.CompanyName });
      console.log(`  [${processed}] ⚠️  sin email          → ${label}`);
      continue;
    }

    if ((emailCount.get(email) || 0) > 1) {
      report.skippedDuplicateEmail.push({ qbId: customer.Id, companyName: customer.CompanyName, email });
      console.log(`  [${processed}] ⚠️  email duplicado    → ${label}`);
      continue;
    }

    const notes = (customer.Notes || '').trim();
    if (!notes) {
      report.skippedNoNotes.push({ qbId: customer.Id, companyName: customer.CompanyName, email });
      console.log(`  [${processed}] ⚠️  sin notes          → ${label}`);
      continue;
    }

    if (!/^\d/.test(notes) || notes.length > 16) {
      report.skippedInvalidNotes.push({ qbId: customer.Id, companyName: customer.CompanyName, email, notes });
      console.log(`  [${processed}] ⚠️  notes inválido     → ${label} (${notes})`);
      continue;
    }

    if ((notesCount.get(notes) || 0) > 1) {
      report.skippedDuplicateNotes.push({ qbId: customer.Id, companyName: customer.CompanyName, email, notes });
      console.log(`  [${processed}] ⚠️  notes duplicado    → ${label} (${notes})`);
      continue;
    }

    try {
      const result = await processCustomer(customer);
      if (result.status === 'already_mapped') {
        report.alreadyMapped.push(result);
        console.log(`  [${processed}] ⏩  ya enlazado     → ${label}`);
      } else if (result.status.startsWith('would_')) {
        report.migrated.push(result);
        console.log(`  [${processed}] 🔵 [DRY] ${result.status.padEnd(13)}→ ${label}`);
      } else {
        report.migrated.push(result);
        console.log(`  [${processed}] ✅ ${result.status.padEnd(17)}→ ${label} → HS ${result.hsContactId}`);
      }
    } catch (err) {
      report.failed.push({
        qbId: customer.Id,
        companyName: customer.CompanyName,
        email,
        error: err.message
      });
      console.log(`  [${processed}] ❌ falló           → ${label} — ${err.message}`);
    }

    await sleep(THROTTLE_MS);
  }

  report.finishedAt = new Date().toISOString();

  console.log('\n============================================================');
  console.log('  REPORTE FINAL');
  console.log('============================================================');
  console.log(`  ✅ Procesados OK:           ${report.migrated.length}`);
  console.log(`  ⏩ Ya enlazados (skip):     ${report.alreadyMapped.length}`);
  console.log(`  ⚠️  Sin email (skip):        ${report.skippedNoEmail.length}`);
  console.log(`  ⚠️  Email duplicado (skip):  ${report.skippedDuplicateEmail.length}`);
  console.log(`  ❌ Fallidos:                ${report.failed.length}`);
  console.log('============================================================\n');

  const reportDir = path.join(process.cwd(), 'migration-reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(
    reportDir,
    `migration-${Date.now()}${DRY_RUN ? '-dryrun' : ''}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`📄 Reporte guardado: ${reportFile}\n`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('💥 Error crítico:', err.message);
  console.error(err.stack);
  process.exit(1);
});
