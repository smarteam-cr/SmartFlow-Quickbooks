# Migrate QB Contacts v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Actualizar `src/scripts/migrate-qb-contacts.js` para usar Notes como campo de identidad, validar email/notes contra todos los customers activos de QB, incrementar el throttle a 500ms, y exportar un CSV con los contactos omitidos.

**Architecture:** Un único archivo de script modificado. Todos los cambios son aditivos o sustituciones directas; la estructura general del script (fetch → filter → pre-compute → loop → report) no cambia. No se tocan otros archivos del proyecto.

**Tech Stack:** Node.js CommonJS, MongoDB via Mongoose, HubSpot client interno, QuickBooks client interno.

---

## Mapa de archivos

| Archivo | Acción |
|---|---|
| `src/scripts/migrate-qb-contacts.js` | Modificar (único archivo) |

---

### Task 1: Constantes, forma del reporte y helpers de CSV

**Files:**
- Modify: `src/scripts/migrate-qb-contacts.js`

- [ ] **Step 1: Cambiar THROTTLE_MS de 250 a 500**

En la línea 39, reemplazar:
```javascript
const THROTTLE_MS = 250;
```
Por:
```javascript
const THROTTLE_MS = 500;
```

- [ ] **Step 2: Añadir las funciones csvField y generateCsv justo antes de la función `isEligibleCustomer` (línea 51)**

Insertar este bloque entre la función `normalizeEmail` y `isEligibleCustomer`:
```javascript
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
```

- [ ] **Step 3: Ampliar el objeto `report` en la función `run()` con las nuevas categorías**

Localizar el bloque `const report = {` (actualmente línea ~234) y reemplazarlo por:
```javascript
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
```

- [ ] **Step 4: Verificar que el archivo sigue siendo JS válido**

```bash
node --check src/scripts/migrate-qb-contacts.js
```
Esperado: sin output (sin errores de sintaxis).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/migrate-qb-contacts.js
git commit -m "feat(migrate): add CSV helpers, new report categories, throttle 500ms"
```

---

### Task 2: Reemplazar el pre-cómputo de colisiones

**Files:**
- Modify: `src/scripts/migrate-qb-contacts.js`

- [ ] **Step 1: Reemplazar el bloque de pre-cómputo de emails (actualmente líneas ~221–232)**

Localizar y reemplazar el bloque completo que empieza con el comentario `// Detección de colisiones en los primeros 16 chars del email`:

**Código VIEJO (reemplazar todo esto):**
```javascript
  // Detección de colisiones en los primeros 16 chars del email (límite del campo Suffix de QB)
  const emailPrefixCount = new Map();
  for (const c of eligible) {
    const e = normalizeEmail(c.PrimaryEmailAddr?.Address);
    if (!e) continue;
    const prefix = e.slice(0, 16);
    emailPrefixCount.set(prefix, (emailPrefixCount.get(prefix) || 0) + 1);
  }
  const duplicatedEmails = new Set(
    [...emailPrefixCount.entries()].filter(([, n]) => n > 1).map(([p]) => p)
  );
  console.log(`   Colisiones en primeros 16 chars de email: ${duplicatedEmails.size}\n`);
```

**Código NUEVO:**
```javascript
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
```

- [ ] **Step 2: Verificar sintaxis**

```bash
node --check src/scripts/migrate-qb-contacts.js
```
Esperado: sin output.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/migrate-qb-contacts.js
git commit -m "feat(migrate): replace email-prefix collision map with full email+notes frequency maps over all QB customers"
```

---

### Task 3: Actualizar la lógica de skip en el loop principal

**Files:**
- Modify: `src/scripts/migrate-qb-contacts.js`

- [ ] **Step 1: Reemplazar el bloque de validaciones dentro del loop `for (const customer of eligible)`**

Localizar el bloque que empieza con `if (!email)` y termina antes del bloque `try {` (actualmente líneas ~258–271). Reemplazar todo ese bloque por:

```javascript
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
```

- [ ] **Step 2: Verificar sintaxis**

```bash
node --check src/scripts/migrate-qb-contacts.js
```
Esperado: sin output.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/migrate-qb-contacts.js
git commit -m "feat(migrate): add notes validation (sin_notes, notes_invalido, notes_duplicado) and expand email uniqueness to all QB customers"
```

---

### Task 4: Cambiar la fuente del suffix de email a Notes en processCustomer

**Files:**
- Modify: `src/scripts/migrate-qb-contacts.js`

- [ ] **Step 1: Cambiar el cálculo de `suffix` en `processCustomer` (línea ~127)**

Localizar esta línea dentro de `async function processCustomer(customer)`:
```javascript
  const suffix = normalizeEmail(email).slice(0, 16); // QB Suffix max 16 chars
```
Reemplazar por:
```javascript
  const suffix = (customer.Notes || '').trim(); // Identity key: Notes → Suffix (QB) / documento_de_identidad (HS)
```

- [ ] **Step 2: Actualizar el comentario en el paso 2 dentro de processCustomer (línea ~184)**

Localizar:
```javascript
  // 2. Actualizar QB: CompanyName → GivenName, Suffix = primeros 16 chars del email, CompanyName limpio
```
Reemplazar por:
```javascript
  // 2. Actualizar QB: CompanyName → GivenName, Suffix = Notes, CompanyName limpio. Notes se preserva en QB.
```

- [ ] **Step 3: Renombrar el parámetro `suffixEmail` a `suffix` en `buildHashForMapping` (línea ~104)**

Localizar la firma de la función:
```javascript
function buildHashForMapping(customer, givenName, suffixEmail) {
```
Y la propiedad que lo usa dentro:
```javascript
    documento_de_identidad: suffixEmail,
```
Reemplazar ambas por:
```javascript
function buildHashForMapping(customer, givenName, suffix) {
```
```javascript
    documento_de_identidad: suffix,
```
> Nota: la llamada `buildHashForMapping(customer, companyName, suffix)` en el cuerpo de `processCustomer` no cambia porque ya pasaba la variable `suffix`.

- [ ] **Step 4: Actualizar el docstring del archivo al inicio (líneas 1–17)**

Reemplazar la descripción en el comentario del encabezado:
```javascript
/**
 * Migración one-shot QB → HS para el cohort legacy de contactos.
 * Procesa QB customers con `CompanyName` poblado pero sin `GivenName`/`FamilyName`:
 * los enlaza al contacto HS correspondiente (por email) o los crea en HS, y
 * reestructura el QB customer para que el sync normal los reconozca como
 * personas en adelante (GivenName = CompanyName, Suffix = Notes, CompanyName limpio).
 *
 * Condiciones de elegibilidad:
 *   1. CompanyName poblado, GivenName y FamilyName vacíos.
 *   2. Email presente y único entre TODOS los customers activos de QB.
 *   3. Notes presente, empieza con dígito (0-9), máximo 16 chars, y único entre TODOS los customers activos de QB.
 *
 * Uso:
 *   node src/scripts/migrate-qb-contacts.js [--limit=N] [--dry-run]
 *
 * Precondiciones antes de ejecutar:
 *   1. Borrar jobs pendientes: db.syncjobs.deleteMany({ status: { $in: ["PENDING","RETRY_PENDING"] } })
 *   2. Pausar el worker (comentar await startWorker() en src/server.js y reiniciar)
 *   3. Desactivar webhooks en HubSpot y QuickBooks (o instruir al equipo que no toque QB)
 *   4. Hacer backup de la colección entitymappings en MongoDB
 *
 * Idempotencia: customers con EntityMapping existente se saltan automáticamente (already_mapped).
 * Para reintentar fallidos: volver a correr el script; los ya migrados se saltan, los fallidos se reintentan.
 */
```

- [ ] **Step 5: Verificar sintaxis**

```bash
node --check src/scripts/migrate-qb-contacts.js
```
Esperado: sin output.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/migrate-qb-contacts.js
git commit -m "feat(migrate): use Notes field as identity key (Suffix/documento_de_identidad) instead of email prefix"
```

---

### Task 5: Actualizar el resumen final y escribir el CSV

**Files:**
- Modify: `src/scripts/migrate-qb-contacts.js`

- [ ] **Step 1: Reemplazar el bloque REPORTE FINAL en `run()`**

Localizar el bloque que empieza con `console.log('\n====...` y termina con `console.log('====...\n')` (actualmente líneas ~300–308). Reemplazar por:

```javascript
  console.log('\n============================================================');
  console.log('  REPORTE FINAL');
  console.log('============================================================');
  console.log(`  ✅ Procesados OK:              ${report.migrated.length}`);
  console.log(`  ⏩ Ya enlazados (skip):        ${report.alreadyMapped.length}`);
  console.log(`  ⚠️  Sin email (skip):           ${report.skippedNoEmail.length}`);
  console.log(`  ⚠️  Email duplicado (skip):     ${report.skippedDuplicateEmail.length}`);
  console.log(`  ⚠️  Sin notes (skip):           ${report.skippedNoNotes.length}`);
  console.log(`  ⚠️  Notes inválido (skip):      ${report.skippedInvalidNotes.length}`);
  console.log(`  ⚠️  Notes duplicado (skip):     ${report.skippedDuplicateNotes.length}`);
  console.log(`  ❌ Fallidos:                   ${report.failed.length}`);
  console.log('============================================================\n');
```

- [ ] **Step 2: Reemplazar el bloque de escritura del JSON para añadir el CSV al lado**

Localizar el bloque (actualmente líneas ~310–317):
```javascript
  const reportDir = path.join(process.cwd(), 'migration-reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(
    reportDir,
    `migration-${Date.now()}${DRY_RUN ? '-dryrun' : ''}.json`
  );
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`📄 Reporte guardado: ${reportFile}\n`);
```
Reemplazar por:
```javascript
  const reportDir = path.join(process.cwd(), 'migration-reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const fileTs = Date.now();
  const fileSuffix = DRY_RUN ? '-dryrun' : '';
  const reportFile = path.join(reportDir, `migration-${fileTs}${fileSuffix}.json`);
  const csvFile = path.join(reportDir, `migration-${fileTs}${fileSuffix}.csv`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(csvFile, generateCsv(report));
  console.log(`📄 Reporte JSON: ${reportFile}`);
  console.log(`📄 Reporte CSV:  ${csvFile}\n`);
```

- [ ] **Step 3: Verificar sintaxis final**

```bash
node --check src/scripts/migrate-qb-contacts.js
```
Esperado: sin output.

- [ ] **Step 4: Commit**

```bash
git add src/scripts/migrate-qb-contacts.js
git commit -m "feat(migrate): update summary console output and add CSV export alongside JSON report"
```

---

### Task 6: Verificación en dry-run

**Files:** ninguno (solo ejecución de verificación)

- [ ] **Step 1: Ejecutar en modo dry-run**

```bash
node src/scripts/migrate-qb-contacts.js --dry-run
```

- [ ] **Step 2: Verificar estructura del output en consola**

Confirmar que el output muestra:
- Línea `Emails duplicados en QB (todos):`
- Línea `Notes duplicados en QB (todos):`
- Líneas de skip con los nuevos motivos: `sin notes`, `notes inválido`, `notes duplicado`, `email duplicado`
- El REPORTE FINAL con las 7 categorías (✅, ⏩, ⚠️ ×5, ❌)

- [ ] **Step 3: Verificar que se generaron ambos archivos de reporte**

```bash
ls -lh migration-reports/ | tail -5
```
Esperado: dos archivos con el mismo timestamp — un `.json` y un `.csv`, ambos con sufijo `-dryrun`.

- [ ] **Step 4: Verificar que el CSV tiene el header correcto y campos entre comillas**

```bash
head -3 migration-reports/*dryrun.csv
```
Esperado primera línea: `qbId;companyName;email;notes;motivo_skip`
Las líneas de datos deben tener campos entre comillas dobles.

- [ ] **Step 5: Verificar que el JSON tiene las nuevas categorías**

```bash
node -e "
const fs = require('fs');
const latest = fs.readdirSync('migration-reports').filter(f => f.endsWith('-dryrun.json')).sort().pop();
const r = JSON.parse(fs.readFileSync('migration-reports/' + latest, 'utf8'));
console.log(Object.keys(r).filter(k => k.startsWith('skipped')));
"
```
Esperado: `[ 'skippedNoEmail', 'skippedDuplicateEmail', 'skippedNoNotes', 'skippedInvalidNotes', 'skippedDuplicateNotes' ]`
