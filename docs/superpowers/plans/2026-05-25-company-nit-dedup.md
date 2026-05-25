# Company NIT-Based Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use `nit` as the identity key for companies (same pattern as `documento_de_identidad`/`Suffix` for contacts), enabling reliable dedup in both HS->QB and QB->HS directions.

**Architecture:** Companies will include `nit` in their QB `DisplayName` (format: `"CompanyName NIT"`). A new `findCompanyByNit` function in `quickbooks.client.js` will use `LIKE '%nit%'` + client-side filter on `AlternatePhone.FreeFormNumber` (same strategy as `findCustomerBySuffix` for contacts). A new `searchCompanyByNit` function in `hubspot.client.js` will search HS companies by the `nit` property. Missing `nit` will throw `MissingIdentityError` and mark the job as SKIPPED.

**Tech Stack:** Node.js (CommonJS), Fastify, MongoDB, HubSpot API v3, QuickBooks Online API

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/utils/errors.util.js` | Modify | Add `MissingNitError` class |
| `src/integrations/quickbooks/quickbooks.client.js` | Modify | Add `findCompanyByNit` function |
| `src/integrations/hubspot/hubspot.client.js` | Modify | Add `searchCompanyByNit` function |
| `src/services/company.sync.service.js` | Modify | Rewrite dedup logic in both directions |
| `CLAUDE.md` | Modify | Document new company identity key behavior |

---

### Task 1: Add `MissingNitError` to error utilities

**Files:**
- Modify: `src/utils/errors.util.js:68-78`

- [ ] **Step 1: Add `MissingNitError` class**

In `src/utils/errors.util.js`, add the new error class after `MissingIdentityError` (line 72) and before `CurrencyMismatchError` (line 74):

```javascript
class MissingNitError extends SkipJobError {
  constructor(message = 'Empresa sin NIT: no se puede sincronizar con QuickBooks.') {
    super(message, 'MISSING_NIT');
  }
}
```

- [ ] **Step 2: Export `MissingNitError`**

Add `MissingNitError` to the `module.exports` object in the same file (line 80-92):

```javascript
module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  SkipJobError,
  InactiveCustomerError,
  InactiveParentError,
  MissingIdentityError,
  MissingNitError,
  CurrencyMismatchError,
};
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/errors.util.js
git commit -m "feat: add MissingNitError for company sync without NIT"
```

---

### Task 2: Add `findCompanyByNit` to QuickBooks client

**Files:**
- Modify: `src/integrations/quickbooks/quickbooks.client.js:164-194`

This function follows the exact same pattern as `findCustomerBySuffix` (line 176-194): `LIKE` search on `DisplayName` to find candidates, then client-side filter on `AlternatePhone.FreeFormNumber` for exact match.

- [ ] **Step 1: Add `findCompanyByNit` function**

Add after `findCustomerBySuffix` (after line 194):

```javascript
/**
 * Busca un Customer-empresa en QB por NIT.
 * Se usa como dedup primario en el flujo HS->QB de empresas.
 *
 * Misma estrategia que findCustomerBySuffix: QB no permite query directo
 * sobre AlternatePhone, así que hacemos LIKE sobre DisplayName (que incluye
 * el NIT como sufijo) y filtramos client-side por AlternatePhone exacto.
 */
async function findCompanyByNit(nit) {
  if (!nit) return null;
  try {
    const baseUrl = await getBaseResourceUrl();
    const safeNit = String(nit)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/[%_]/g, "");
    const query = `SELECT * FROM Customer WHERE DisplayName LIKE '%${safeNit}%'`;
    const response = await qbClient.get(`${baseUrl}/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const candidates = response.data.QueryResponse.Customer || [];
    const exactMatch = candidates.find(c => c.AlternatePhone?.FreeFormNumber === nit);
    return exactMatch || null;
  } catch (error) {
    const detail = extractAxiosError(error);
    logger.error(`Error buscando empresa por NIT: ${detail}`);
    throw new Error(detail);
  }
}
```

- [ ] **Step 2: Export `findCompanyByNit`**

Add `findCompanyByNit` to `module.exports` (line 491-513):

```javascript
module.exports = {
  qbClient,
  getPaymentDetails,
  findCustomerByEmail,
  createCustomer,
  findCustomerByDisplayName,
  findCustomerBySuffix,
  findCompanyByNit,
  getAllCustomers,
  // ... rest unchanged
};
```

- [ ] **Step 3: Commit**

```bash
git add src/integrations/quickbooks/quickbooks.client.js
git commit -m "feat: add findCompanyByNit for company dedup in QB"
```

---

### Task 3: Add `searchCompanyByNit` to HubSpot client

**Files:**
- Modify: `src/integrations/hubspot/hubspot.client.js:149-169`

This function follows the same pattern as `searchCompanyByQbId` (line 149) but searches by the `nit` property instead of `id_usuario_quickbooks`.

- [ ] **Step 1: Add `searchCompanyByNit` function**

Add after `searchCompanyByQbId` (after line 169):

```javascript
async function searchCompanyByNit(nit) {
  try {
    const payload = {
      filterGroups: [{
        filters: [{
          propertyName: "nit",
          operator: "EQ",
          value: nit.toString(),
        }],
      }],
      properties: ["name", "nit", "id_usuario_quickbooks"],
    };
    const response = await hsClient.post("/crm/v3/objects/companies/search", payload);
    if (response.data.total > 0) {
      return response.data.results[0];
    }
    return null;
  } catch (error) {
    logger.error(`Error buscando empresa en HubSpot con NIT ${nit}:`, error);
    throw error;
  }
}
```

- [ ] **Step 2: Export `searchCompanyByNit`**

Add `searchCompanyByNit` to `module.exports` (line 650-691):

```javascript
module.exports = {
  // ... existing exports
  searchCompanyByQbId,
  searchCompanyByNit,
  // ... rest unchanged
};
```

- [ ] **Step 3: Commit**

```bash
git add src/integrations/hubspot/hubspot.client.js
git commit -m "feat: add searchCompanyByNit for company dedup in HS"
```

---

### Task 4: Rewrite `company.sync.service.js` — HS->QB direction

**Files:**
- Modify: `src/services/company.sync.service.js:1-94`

This is the core change. We modify `normalizeHsCompanyToQb` to include `nit` in `displayName`, add `nit` validation, and replace `findCustomerByDisplayName` with `findCompanyByNit`.

- [ ] **Step 1: Add `MissingNitError` import**

Replace the imports section (lines 1-7) with:

```javascript
const crypto = require('crypto');
const hubspotClient = require('../integrations/hubspot/hubspot.client');
const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const mappingService = require('./mapping.service');
const echoSuppression = require('../utils/echo.suppression.util');
const logger = require('../lib/logger.lib');
const { DEFAULT_TENANT_ID } = require('../config/constants');
const { MissingNitError } = require('../utils/errors.util');
```

- [ ] **Step 2: Update `normalizeHsCompanyToQb` to include nit in displayName**

Replace the `normalizeHsCompanyToQb` function (lines 9-18) with:

```javascript
function normalizeHsCompanyToQb(company) {
    const props = company.properties || {};
    const nit = props.nit || "";
    const companyName = props.name || "";
    const displayName = nit
        ? `${companyName} ${nit}`.trim()
        : companyName || props.domain || `Company-${company.id}`;
    return {
        companyName, nit, phone: props.phone || "",
        domain: props.domain || "", address: props.address || "", city: props.city || "",
        state: props.state || "", zip: props.zip || "", country: props.country || "",
        preferredCurrency: props.moneda_de_preferencia || "",
        displayName
    };
}
```

- [ ] **Step 3: Add nit validation and replace dedup in `processCompany`**

Replace the `processCompany` function (lines 39-94) with:

```javascript
async function processCompany(hsCompanyId, tenantId = DEFAULT_TENANT_ID) {
    if (echoSuppression.wasCreatedInHs(hsCompanyId)) {
        logger.info(`♻️ [Echo Check] Ignorando evento de Empresa HS ID ${hsCompanyId} (generado internamente).`);
        return null;
    }

    logger.info(`[Sync] Procesando Empresa HS ID: ${hsCompanyId}`, { source: 'HUBSPOT', entity: 'company', entityId: hsCompanyId, tenantId });

    const company = await hubspotClient.getCompanyDetails(hsCompanyId);
    if (!company) return null;

    if (!company.properties?.nit) {
        throw new MissingNitError(`Empresa HS ${hsCompanyId} sin NIT. Se omite el sync con QuickBooks.`);
    }

    const normalizedData = normalizeHsCompanyToQb(company);
    const newHash = generateHash(normalizedData);
    const mapping = await mappingService.findByHsId(tenantId, 'company', hsCompanyId);
    let qbCustomerId = null;

    if (mapping && mapping.qbId) {
        qbCustomerId = mapping.qbId;
        if (mapping.payloadHash === newHash) {
            logger.info(`⏩ Empresa sin cambios reales (Hash coincide). Omitiendo QB.`);
            return { qbCustomerId };
        }

        logger.info(`📝 Actualizando empresa en QuickBooks...`);

        const currentQbData = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
        if (!currentQbData) {
            logger.warn(`⚠️ Empresa QB ${qbCustomerId} no encontrada. No se puede actualizar.`);
            return { qbCustomerId };
        }

        echoSuppression.markAsCreatedInQb(qbCustomerId);
        const updated = await quickbooksClient.updateCustomer(qbCustomerId, currentQbData.SyncToken, normalizedData);

        await mappingService.upsertMapping({
            tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
            qbSyncToken: updated.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
        });
    } else {
        let existingQb = await quickbooksClient.findCompanyByNit(normalizedData.nit);
        if (!existingQb) {
            existingQb = await quickbooksClient.createCustomer(normalizedData);
            echoSuppression.markAsCreatedInQb(existingQb.Id);
        }
        qbCustomerId = existingQb.Id;

        await mappingService.upsertMapping({
            tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
            qbSyncToken: existingQb.SyncToken, payloadHash: newHash, sourceSystem: 'HUBSPOT'
        });
        echoSuppression.markAsCreatedInHs(hsCompanyId);
        await hubspotClient.updateCompanyProperty(hsCompanyId, qbCustomerId);
    }
    return { qbCustomerId };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/services/company.sync.service.js
git commit -m "feat: use NIT as identity key for HS->QB company dedup"
```

---

### Task 5: Rewrite `company.sync.service.js` — QB->HS direction

**Files:**
- Modify: `src/services/company.sync.service.js:99-138`

Replace `searchCompanyByQbId` with `searchCompanyByNit` as the fallback dedup mechanism. Skip companies without `AlternatePhone` (nit).

- [ ] **Step 1: Update `syncCompanyFromQuickbooks`**

Replace the `syncCompanyFromQuickbooks` function (lines 99-138) with:

```javascript
async function syncCompanyFromQuickbooks(qbCustomerId, tenantId = DEFAULT_TENANT_ID) {
    logger.info(`[Sync] Sincronizando Empresa QB ID: ${qbCustomerId} hacia HubSpot`);

    if (echoSuppression.wasCreatedInQb(qbCustomerId)) return;

    const qbCustomer = await quickbooksClient.getCustomerById(qbCustomerId).catch(() => null);
    if (!qbCustomer) return;

    const qbNit = qbCustomer.AlternatePhone?.FreeFormNumber || "";
    if (!qbNit) {
        logger.warn(`⚠️ Customer QB ${qbCustomerId} sin AlternatePhone (NIT). Omitiendo sync a HS.`);
        return;
    }

    const hsProps = normalizeQbCompanyToHs(qbCustomer);
    const newHash = generateHash(hsProps);
    const mapping = await mappingService.findByQbId(tenantId, 'company', qbCustomerId);
    let hsCompanyId = mapping ? mapping.hsId : null;

    if (hsCompanyId) {
        if (mapping.payloadHash === newHash) {
            logger.info(`⏩ Empresa sin cambios reales (Hash coincide). Omitiendo actualización en HS.`);
        } else {
            echoSuppression.markAsCreatedInHs(hsCompanyId);
            await hubspotClient.updateCompany(hsCompanyId, hsProps);
            await mappingService.upsertMapping({
                tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
                qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
            });
        }
    } else {
        const existingHs = await hubspotClient.searchCompanyByNit(qbNit);
        if (existingHs) {
            hsCompanyId = existingHs.id;
            echoSuppression.markAsCreatedInHs(hsCompanyId);
            await hubspotClient.updateCompany(hsCompanyId, hsProps);
        } else {
            const newCompany = await hubspotClient.createCompany(hsProps);
            hsCompanyId = newCompany.id;
            echoSuppression.markAsCreatedInHs(hsCompanyId);
        }
        await mappingService.upsertMapping({
            tenantId, entityType: 'company', hsId: hsCompanyId, qbId: qbCustomerId,
            qbSyncToken: qbCustomer.SyncToken, payloadHash: newHash, sourceSystem: 'QUICKBOOKS'
        });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/company.sync.service.js
git commit -m "feat: use NIT as identity key for QB->HS company dedup"
```

---

### Task 6: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add company identity key documentation**

In the **Contacts / Companies** section of CLAUDE.md, after the line about companies using `nit` for dedup (around line 60), add/replace the company dedup documentation:

```markdown
- **Identity key for companies**: `nit` (HS custom property) <-> `AlternatePhone.FreeFormNumber` (QB field). This field is **mandatory** -- companies without it throw `MissingNitError` and the job is marked SKIPPED. Never reaches QB.
- QB `DisplayName` for companies is built as `"${companyName} ${nit}"` (nit included to enable LIKE-based search, same strategy as contacts with documento_de_identidad).
- HS -> QB: lookup by EntityMapping -> fallback `findCompanyByNit` (LIKE on DisplayName + client-side filter on exact AlternatePhone.FreeFormNumber) -> create.
- QB -> HS: lookup by EntityMapping -> fallback `searchCompanyByNit` (searches by `nit` property in HS) -> create. If QB `AlternatePhone` is empty, the company is skipped with a warning.
```

Remove the old line that says:
```markdown
- Companies use `nit` (HS) for dedup -- unrelated to the contact identity key above.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document NIT as company identity key in CLAUDE.md"
```

---

## Summary of Changes

| File | What Changes |
|------|-------------|
| `errors.util.js` | +`MissingNitError` class (6 lines) |
| `quickbooks.client.js` | +`findCompanyByNit` function (22 lines) |
| `hubspot.client.js` | +`searchCompanyByNit` function (20 lines) |
| `company.sync.service.js` | Rewrite `normalizeHsCompanyToQb` displayName, add nit validation in `processCompany`, replace `findCustomerByDisplayName` with `findCompanyByNit`, replace `searchCompanyByQbId` with `searchCompanyByNit` in `syncCompanyFromQuickbooks` |
| `CLAUDE.md` | Document new company identity key behavior |

## What Does NOT Change

- `quickbooks.client.js`: `createCustomer` and `updateCustomer` already handle `nit` -> `AlternatePhone` and `companyName` -> `CompanyName` correctly. No changes needed.
- `contact.sync.service.js`: contacts use their own identity key (`documento_de_identidad`/`Suffix`). Unaffected.
- `invoice.sync.service.js`, `payment.sync.service.js`: depend on contact sync, not company sync directly. Unaffected.
- Migration scripts: only handle contacts, not companies. Unaffected.
