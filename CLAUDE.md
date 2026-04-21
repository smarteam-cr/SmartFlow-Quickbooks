# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Development with auto-restart (node --watch)
npm start        # Production start
```

No test suite or linter is configured. There is no build step — this is a plain Node.js CommonJS project.

## Architecture Overview

This is a **bidirectional sync integration** between HubSpot (CRM) and QuickBooks (accounting), built with Fastify + MongoDB. It is **not** a REST API — it exposes only webhook endpoints and processes everything asynchronously via a job queue.

### Request Flow

```
HubSpot/QB Webhook → webhook.routes.js → webhook.controller.js
    → creates SyncJob in MongoDB
    → worker.js picks it up (concurrency: 3)
    → routes to sync service
    → calls integration client (HS or QB)
    → updates EntityMapping in MongoDB
```

### Key Architectural Decisions

**Job Queue is MongoDB-backed** (`src/db/models/job.model.js`). Jobs persist across restarts. The worker uses `findOneAndUpdate` to atomically claim jobs. A MongoDB Change Stream wakes the worker on new inserts. Orphaned PROCESSING jobs are recovered to COMPLETED on startup.

**Retry system**: failed jobs go to `RETRY_PENDING`, a 30-second poller picks them up with exponential backoff. Max 3 attempts by default (`MAX_RETRY_ATTEMPTS` env).

**Echo suppression** (`src/utils/echo.suppression.util.js`): when the sync writes back to HS or QB, it marks those IDs in-memory so the resulting webhook doesn't create a loop.

**Mutex per entity** (`src/utils/mutex.util.js`): the worker also wraps jobs with a per-entity-ID mutex to prevent concurrent writes to the same record. `contact.sync.service.js` has an additional in-process `_contactLocks` Map for the same contact being processed by concurrent jobs.

**EntityMapping** (`src/db/models/entity_mapping.model.js`): the source of truth for `hsId ↔ qbId` relationships. Has unique indexes on `(tenantId, entityType, hsId)` and `(tenantId, entityType, qbId)`. When a mapping exists, the sync skips re-resolution in the other platform.

**Hash-based idempotency**: each mapping stores an MD5 hash of the last synced payload. If the hash matches on the next event, the external API call is skipped entirely.

**Hash format mismatch between directions**: HS→QB (`processContact`) and QB→HS (`syncCustomerFromQuickbooks`) compute the hash over different JSON structures (different field names). As a result, after a QB→HS-originated write (e.g., the migration script or any QB→HS update), the first HS→QB event for that contact will always see a hash mismatch and trigger a QB update. This is harmless when HS and QB data are already identical — the QB update is a no-op. Echo suppression prevents the resulting QB webhook from looping back. After that first cross-direction event, the hash stabilizes for its direction.

### Sync Logic per Entity

**Contacts / Companies** (`contact.sync.service.js`, `company.sync.service.js`):
- **Identity key for contacts**: `documento_de_identidad` (HS custom property) ↔ `Suffix` (QB field). This field is **mandatory** — contacts without it are silently skipped and never synced to QB.
- **QB `Suffix` field is limited to 16 characters** (hard QB API limit). `normalizeHsContactToQb` truncates `documento_de_identidad` to 16 chars via `.substring(0, 16)`. `createCustomer` and `updateCustomer` in `quickbooks.client.js` apply the same truncation. Contacts with real cedulas (≤16 chars) are unaffected.
- QB `DisplayName` for contacts is built as `"${firstname} ${lastname} ${documento_de_identidad}"` (truncated suffix included to guarantee uniqueness across same-name customers).
- HS → QB: lookup by EntityMapping → fallback `findCustomerByDisplayName` (DisplayName includes ID, so it's unique) → create
- QB → HS: lookup by EntityMapping → fallback `searchContactByIdentification` (searches by `documento_de_identidad`) → create. If QB `Suffix` is empty, the contact is skipped with a warning.
- `processContact` returns `{ qbCustomerId, contactInfo: normalizedData }`. `contactInfo` is consumed by `mapInvoicePayload` to set `BillAddr` on QB invoices.
- Sub-customers in QB (Job=true or ParentRef) map to HS contacts associated to a company
- Companies use `nit` (HS) for dedup — unrelated to the contact identity key above
- `searchContactByEmail` (HS client) only returns `email`, `firstname`, `lastname`, `id_usuario_quickbooks` — it does **not** return `documento_de_identidad`. Use `getContactDetails` if that field is needed.

**Products** (`product.sync.service.js`):
- `processProduct(hsProductId)` resolves the QB Item ID for an HS product
- If mapping exists but QB item is inactive (`Active === false`), creates a new item and updates the mapping
- `findItemByName` always filters `AND Active = true` — soft-deleted QB items are invisible to the search and will be recreated

**Invoices** (`invoice.sync.service.js`):
- HS → QB: only fires when `hs_balance_due = 0` (the webhook controller ignores partial-balance events)
- `resolveQbItemIdForLineItem()` tries 3 paths: (1) `id_producto_quickbooks` on the line item (validated for active status), (2) `hs_product_id` → processProduct, (3) name search → create fallback
- After creating the QB invoice, `reconcilePaymentsForInvoice()` links any existing unlinked QB payments by `PaymentRefNum`
- QB → HS: only on `operation=Emailed`, marks HS invoice as paid

**Payments** (`payment.sync.service.js`):
- HS → QB: creates an Unapplied Payment in QB against the resolved customer
- Reconciliation happens inside `syncInvoiceToQuickbooks` after invoice creation

### Multi-Tenancy

The system is designed for multiple tenants but currently runs with `DEFAULT_TENANT_ID`. Tenant credentials (HubSpot token, QB tokens, preferences like `incomeAccountId`, `utcOffsetMilliseconds`) are stored in `tenant.model.js` and retrieved dynamically. QB tokens are refreshed automatically on 401 via the Axios interceptor in `quickbooks.client.js`.

### Error Handling

`src/utils/axios.error.util.js` exports `extractAxiosError(error)` which parses both QB (`Fault.Error[0]`) and HS (`message`/`errors`) error formats into a readable string. All QB client functions use this — never pass a raw Axios error to `logger.error`.

The logger (`src/lib/logger.lib.js`) has a `safeReplacer` that handles Axios errors and circular references, so `logger.error('msg', error)` is safe but will produce less detail than using `extractAxiosError` explicitly.

### Environment Variables

Required: `MONGODB_URI`, `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_APP_SECRET`, `QB_SANDBOX_BASE_URL`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`, `ENCRYPTION_KEY` (64 hex chars for AES-256), `DEFAULT_TENANT_ID`.

QB tokens (`QB_TEST_ACCESS_TOKEN`, `QB_REALM_ID`) are stored per-tenant in MongoDB and refreshed at runtime — the env vars are only used for initial seeding.

### Webhook Endpoints

- `POST /webhook/hubspot-pruebas-testing` — HubSpot events (HMAC validated)
- `POST /webhook/quickbooks-pruebas` — QuickBooks events (Intuit signature validated)

Signature validation is currently bypassed in dev mode via a flag in `auth.middleware.js`.

### Logs

Winston writes to `logs/app-YYYY-MM-DD.log` (all levels) and `logs/error-YYYY-MM-DD.log` (errors only), JSON format, 14/30-day retention. Console output is human-readable and only active when `NODE_ENV !== 'production'`.

## Migration Script

`src/scripts/migrate-qb-contacts.js` is a one-shot script that migrates **legacy QB customers** that have `CompanyName` set but no `GivenName`/`FamilyName` (and no `Suffix`). These customers are misclassified as companies by the sync system (`isPerson` check fails) and must be restructured before normal sync can recognize them as contacts.

**What it does per customer:**
1. Checks EntityMapping — skips if already linked.
2. Searches HS by email. If found: updates all QB fields to HS and sets `documento_de_identidad = email.slice(0, 16)`. If not found: creates a new HS contact with QB data.
3. Updates QB customer: `GivenName = CompanyName`, `FamilyName = ''`, `Suffix = email.slice(0, 16)`, `CompanyName = ''`, `DisplayName` updated.
4. Creates EntityMapping with hash matching what `syncCustomerFromQuickbooks` would compute — so the first QB webhook post-migration hits hash-match and skips.

**Dedup logic:** uses the first 16 chars of email as the dedup key (matching the QB Suffix limit). Customers whose `email.slice(0, 16)` collides with another eligible customer are skipped and must be migrated manually.

**CLI:**
```bash
node src/scripts/migrate-qb-contacts.js --dry-run        # simulate, no changes
node src/scripts/migrate-qb-contacts.js --limit=5        # real run, first 5 only
node src/scripts/migrate-qb-contacts.js                  # full run
```

**Preconditions before running:**
1. Disable webhooks on HubSpot and QuickBooks (prevent events during migration).
2. Clear pending jobs: `db.syncjobs.deleteMany({ status: { $in: ["PENDING","RETRY_PENDING"] } })`
3. Backup `entitymappings` collection in MongoDB.
4. Re-enable webhooks after script completes. The script is idempotent — already-mapped customers are skipped.
