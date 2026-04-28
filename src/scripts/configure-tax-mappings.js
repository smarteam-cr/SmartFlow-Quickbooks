require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const Tenant = require('../db/models/tenant.model');
const { DEFAULT_TENANT_ID } = require('../config/constants');

function parseArgs() {
  const params = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    params[match[1]] = match[2] ?? true;
  }
  return params;
}

function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('El archivo debe contener un objeto JSON plano con pares "hsDropdownValue": "qbTaxCodeId".');
  }
  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    throw new Error('El archivo está vacío. Debe contener al menos un mapeo.');
  }
  for (const [hsId, qbId] of entries) {
    if (typeof hsId !== 'string' || hsId.trim() === '') {
      throw new Error('Todas las claves deben ser strings no vacíos (HS dropdown internal value).');
    }
    if (typeof qbId !== 'string' || qbId.trim() === '') {
      throw new Error(`El valor para "${hsId}" debe ser un string no vacío (QB TaxCode ID).`);
    }
  }
}

function readCurrentMapping(tenant) {
  const current = {};
  const raw = tenant.preferences?.taxMappings;
  if (!raw) return current;
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) current[k] = v;
  } else if (typeof raw === 'object') {
    Object.assign(current, raw);
  }
  return current;
}

function computeDiff(current, desired) {
  const added = [], removed = [], changed = [], unchanged = [];
  for (const [k, v] of Object.entries(desired)) {
    if (!(k in current)) added.push([k, v]);
    else if (current[k] !== v) changed.push([k, current[k], v]);
    else unchanged.push([k, v]);
  }
  for (const [k, v] of Object.entries(current)) {
    if (!(k in desired)) removed.push([k, v]);
  }
  return { added, removed, changed, unchanged };
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function printEntries(title, entries) {
  console.log(title);
  if (entries.length === 0) console.log('  (vacío)');
  else for (const [k, v] of entries) console.log(`  ${k} → ${v}`);
}

async function main() {
  const args = parseArgs();
  const tenantId = args.tenant || DEFAULT_TENANT_ID;
  const fileArg = args.file;

  if (!fileArg) {
    console.error('Uso: node src/scripts/configure-tax-mappings.js --file=<path> [--tenant=<tenantId>]');
    process.exit(1);
  }

  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`Archivo no encontrado: ${filePath}`);
    process.exit(1);
  }

  let desired;
  try {
    desired = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Error parseando JSON: ${err.message}`);
    process.exit(1);
  }

  try {
    validateMapping(desired);
  } catch (err) {
    console.error(`Archivo inválido: ${err.message}`);
    process.exit(1);
  }

  const MONGO_URI = process.env.MONGODB_URI;
  if (!MONGO_URI) {
    console.error('MONGODB_URI no está definido en .env');
    process.exit(1);
  }

  console.log('\nConectando a MongoDB...');
  await mongoose.connect(MONGO_URI);

  try {
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) {
      console.error(`Tenant no encontrado: ${tenantId}`);
      process.exit(1);
    }

    const current = readCurrentMapping(tenant);
    const diff = computeDiff(current, desired);

    console.log(`\n📋 Tenant: ${tenantId}`);
    console.log(`Archivo:  ${filePath}\n`);

    printEntries('Estado actual en Mongo (taxMappings):', Object.entries(current));
    console.log();
    printEntries('Estado deseado (según archivo):', Object.entries(desired));

    console.log('\nCambios:');
    if (diff.added.length + diff.changed.length + diff.removed.length === 0) {
      console.log('  (ninguno — el archivo coincide con el estado actual)');
      console.log('\nNo hay nada que aplicar. Saliendo.');
      return;
    }
    for (const [k, v] of diff.added) console.log(`  + AGREGAR:  ${k} → ${v}`);
    for (const [k, oldV, newV] of diff.changed) console.log(`  ~ CAMBIAR:  ${k}: ${oldV} → ${newV}`);
    for (const [k, v] of diff.removed) console.log(`  - ELIMINAR: ${k} (era → ${v})`);

    const answer = await prompt('\nAplicar estos cambios? (y/N): ');
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelado. No se hicieron cambios.');
      return;
    }

    await Tenant.updateOne(
      { tenantId },
      { $set: { 'preferences.taxMappings': desired } }
    );

    console.log(`\n✅ taxMappings actualizado en tenant "${tenantId}".`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
