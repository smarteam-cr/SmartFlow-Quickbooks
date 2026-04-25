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
    → worker.js picks it up (concurrency: 3, configurable via WORKER_CONCURRENCY)
    → routes to sync service
    → calls integration client (HS or QB)
    → updates EntityMapping in MongoDB
```

### Key Architectural Decisions

**Job Queue is MongoDB-backed** (`src/db/models/job.model.js`). Jobs persist across restarts. The worker uses `findOneAndUpdate` to atomically claim jobs. A MongoDB Change Stream wakes the worker on new inserts. Orphaned PROCESSING jobs are recovered to COMPLETED on startup.

**Retry system**: failed jobs go to `RETRY_PENDING`, a 30-second poller picks them up with exponential backoff. Max 3 attempts by default (`MAX_RETRY_ATTEMPTS` env).

**SkipJobError** (`src/utils/errors.util.js`): a special error class that signals a business-rule abort, not a failure. The worker catches it and marks the job as **SKIPPED** (not FAILED) so it is not retried. All domain-specific error subclasses extend it: `InactiveCustomerError`, `InactiveParentError`, `MissingIdentityError`, `CurrencyMismatchError`. Throw one of these (or a base `SkipJobError`) when you want to bail out of sync without consuming retries.

**Echo suppression** (`src/utils/echo.suppression.util.js`): when the sync writes back to HS or QB, it marks those IDs in-memory so the resulting webhook doesn't create a loop. TTLs are asymmetric: 10s for HS marks (HS is near-instant), 30s for QB marks (QB batches).

**Mutex per entity** (`src/utils/mutex.util.js`): the worker wraps jobs with a per-entity-ID mutex (`runSequentially(key, fn)`) to prevent concurrent writes to the same record. `contact.sync.service.js` has an additional in-process `_contactLocks` Map for the same contact being processed by concurrent jobs — the second call awaits the first's promise and reuses its result so downstream callers (e.g., invoice sync) get a consistent `contactInfo`/`status`. Invoice creation also uses `runSequentially('invoice-create:${tenantId}', ...)` to serialize DocNumber assignment.

**EntityMapping** (`src/db/models/entity_mapping.model.js`): the source of truth for `hsId ↔ qbId` relationships. Has unique indexes on `(tenantId, entityType, hsId)` and `(tenantId, entityType, qbId)`. When a mapping exists, the sync skips re-resolution in the other platform.

**Hash-based idempotency**: each mapping stores an MD5 hash of the last synced payload. If the hash matches on the next event, the external API call is skipped entirely.

**Hash format mismatch between directions**: HS→QB and QB→HS compute the hash over different JSON structures (different field names — QB-shape vs HS-shape). The first cross-direction event after a write always sees a hash mismatch and triggers an update on the other platform. This is harmless when data is already aligned (the update is a no-op) and echo suppression prevents the resulting webhook from looping back. After that first cross-direction event, the hash stabilizes for its direction.

**Event deduplication** (`src/services/dedupe.service.js`): every incoming webhook event is hashed (sha256 of payload) and stored in `event_dedup` collection. Identical re-deliveries from HS/QB are dropped at the gate before a job is created.

### Sync Logic per Entity

**Contacts / Companies** (`contact.sync.service.js`, `company.sync.service.js`):

- **Identity key for contacts**: `documento_de_identidad` (HS custom property) ↔ `Suffix` (QB field). This field is **mandatory** — contacts without it throw `MissingIdentityError` and the job is marked SKIPPED. Never reaches QB.
- **QB `Suffix` field is limited to 16 characters** (hard QB API limit). `normalizeHsContactToQb` truncates `documento_de_identidad` to 16 chars via `.substring(0, 16)`. `createCustomer` and `updateCustomer` in `quickbooks.client.js` apply the same truncation.
- QB `DisplayName` for contacts is built as `"${firstname} ${lastname} ${documento_de_identidad}"` (truncated suffix included to guarantee uniqueness across same-name customers).
- HS → QB: lookup by EntityMapping → fallback `findCustomerBySuffix` (LIKE on DisplayName + client-side filter on exact Suffix, since QB's `Suffix` is not queryable server-side) → create.
- QB → HS: lookup by EntityMapping → fallback `searchContactByIdentification` (searches by `documento_de_identidad`) → create. If QB `Suffix` is empty, the contact is skipped with a warning.
- `processContact` returns `{ qbCustomerId, contactInfo, status }`. `contactInfo` is consumed by `mapInvoicePayload` to set `BillAddr` on QB invoices; `status` is consumed by invoice/payment sync for fail-fast on inactive customers.
- Sub-customers in QB (Job=true or ParentRef) map to HS contacts associated to a company.
- Companies use `nit` (HS) for dedup — unrelated to the contact identity key above.
- `searchContactByEmail` (HS client) does **not** return `documento_de_identidad`. Use `getContactDetails` if that field is needed.

**Contact status sync** (`estado_del_contacto_qb` HS property ↔ QB `Active` boolean):
- `normalizeHsStatus` defaults any value that is **not exactly** `'inactive'` (including null, empty, undefined) to `'active'`. Only `'inactive'` becomes inactive.
- `statusToQbActive(status)` converts to QB's boolean. `qbActiveToStatus(active)` converts back.
- **InactiveCustomerError**: invoice and payment sync abort with this when the contact resolves to `'inactive'`. Job marked SKIPPED.
- **InactiveParentError**: when a contact tries to activate (HS sets `'active'`) but its QB parent customer is inactive, QB rejects (HTTP 400). Pre-validated in `_doProcessContact`: if detected, HS is reverted to `'inactive'` and the error is thrown so the user fixes the parent first.

**Currency synchronization** (`moneda_de_preferencia` HS property ↔ QB `CurrencyRef.value`):
- QB's `CurrencyRef` is **immutable** once a customer is created. The sync respects this and treats QB as the source of truth post-creation.
- **HS→QB CREATE**: if `moneda_de_preferencia` is set in HS, it is sent as `CurrencyRef`. If empty, QB defaults to the realm's home currency.
- **Currency backfill on CREATE**: if HS came in without `moneda_de_preferencia` and QB ended up with a CurrencyRef (home currency or via `findCustomerBySuffix` match), the value is written back to HS in the same PATCH that sets `id_usuario_quickbooks` (single PATCH, single webhook covered by the 10s `markAsCreatedInHs` TTL). The hash is recomputed with the backfilled value so the next event doesn't trigger a spurious update. Without this, the first invoice would fail the currency validation (layer 1, see below).
- **HS→QB UPDATE drift check** (`contact.sync.service.js` ~line 184): if HS `moneda_de_preferencia` ≠ QB `CurrencyRef`, HS is reverted to QB's value (because QB is immutable). Logs a warning. Prevents invoice validation from passing with desynced data and producing invoices in the wrong currency.
- **Sub-customer parent currency check** (`checkParentCurrencyCompatibility`): QB rejects sub-customers whose CurrencyRef differs from the parent's (error 6000). Pre-checked before assigning `ParentRef`. On mismatch, `ParentRef` is omitted (contact created as independent customer in QB) but the HS company association is preserved. The mismatch can only be fixed manually in QB since CurrencyRef is immutable.

**Products** (`product.sync.service.js`):
- **Bidirectional create + update.** Products can originate in either platform.
- **Field mapping** (QB ↔ HS):
  - `Name` ↔ `name`
  - `Description` ↔ `description`
  - `UnitPrice` ↔ `hs_price_usd` (NOT `price` — `price` in HS is a required placeholder, normally 1)
  - `Sku` ↔ `hs_sku`
  - `Type` ↔ `hs_product_type` (`Service` ↔ `service`, `NonInventory` ↔ `non_inventory`, `Inventory` ↔ `inventory`)
  - `IncomeAccountRef.value` ↔ `cuenta_de_ingresos` (HS dropdown internal values = QB IncomeAccount IDs)
  - `SalesTaxCodeRef.value` ↔ `impuesto_sobre_las_ventas` (HS dropdown internal values = QB TaxCode IDs)
  - `Id` → `id_producto_quickbooks` (QB→HS only)
- **HS→QB create (CASO B)**: requires `name`, `hs_price_usd`, `cuenta_de_ingresos`, `hs_product_type`. If missing, logs warning and skips. If name already exists in QB, links to that item instead of creating a duplicate.
- **Inventory rule**: `hs_product_type=inventory` is rejected on HS→QB (both create and update) with a warning — Inventory items must be created and managed directly in QB because they require stock tracking fields that HS doesn't have. Service ↔ NonInventory transitions from HS are allowed.
- **QB→HS filter**: items with `Type` in `{Category, Group, Bundle}` are skipped — no equivalent in HS.
- **HS→QB update backward-compat**: if HS product doesn't have `cuenta_de_ingresos` / `impuesto_sobre_las_ventas` set (legacy products), those fields are preserved from QB rather than overwritten with empty.
- **Inactive QB items**: if mapping exists but QB item is `Active === false`, HS→QB skips the update (item must be recreated in QB manually). `findItemByName` filters `AND Active = true` — soft-deleted QB items are invisible.
- **Echo suppression**: `processProduct` marks `qbItemId` after create/update and `hsProductId` before writing `id_producto_quickbooks` back to HS.

**Invoices** (`invoice.sync.service.js`):
- HS → QB: only fires when `hs_balance_due = 0` (the webhook controller transforms this into `object.creation` to dispatch).
- **Three-layer currency validation** (fail-fast, no QB call if any layer fails):
  1. **HS-vs-HS** (cheap, no APIs): `hsInvoice.hs_currency` must equal `contactInfo.preferredCurrency`.
  2. **HS-vs-QB**: `hsInvoice.hs_currency` must equal `qbCustomer.CurrencyRef.value` (in case a drift fix hadn't run yet).
  3. **Per-line tax compatibility**: each line item's `hs_tax_rate_group_id` must map (via `tenant.preferences.taxMappings`) to the QB TaxCode that the QB item already has.
  All three throw `CurrencyMismatchError` (or a tax-specific message) with actionable text so the user knows how to fix the data. Job marked SKIPPED.
- **Inactive customer fail-fast**: throws `InactiveCustomerError` before hitting QB.
- **Manual DocNumber generation**: when QB has "Custom Transaction Numbers" enabled, QB does NOT auto-number. We compute the next DocNumber via `computeNextDocNumber({ lastNumber, paddingLength })` which preserves zero-padding (e.g., `"00045"` → `"00046"`). Reads the previous via `quickbooksClient.getLastInvoiceDocNumber()`. The whole create call is wrapped in `runSequentially('invoice-create:${tenantId}', ...)` to prevent two workers from computing the same number simultaneously and one failing with "Duplicate DocNumber".
- `resolveQbItemIdForLineItem()` tries 3 paths: (1) `id_producto_quickbooks` on the line item (validated for active status), (2) `hs_product_id` → processProduct, (3) name search → create fallback.
- After creating the QB invoice, `reconcilePaymentsForInvoice()` links any existing unlinked QB payments by `PaymentRefNum`.
- The mapper inherits QB company preferences (`SalesTermRef`, `PaymentMethodRef`, `BillEmail`) from `getCompanyPreferences()` so invoices match the tenant's QB defaults.
- After successful create, writes `numero_factura_qb` back to the HS invoice.
- QB → HS: only on `operation=Emailed`, marks HS invoice as paid.

**Payments** (`payment.sync.service.js`):
- HS → QB: creates an Unapplied Payment in QB against the resolved customer.
- **DepositToAccountRef routing**: payments are deposited into the QB account configured for the payment's currency in `tenant.preferences.depositAccounts` (e.g., `{ "USD": "1150040004", "CRC": "1150040003" }`). If no mapping exists for the currency, QB uses the realm's default deposit account and a warning is logged.
- Currency validation across contact and invoice (similar to invoice flow).
- Reconciliation between payment and invoice happens inside `syncInvoiceToQuickbooks` after invoice creation.

### Multi-Tenancy

The system is designed for multiple tenants but currently runs with `DEFAULT_TENANT_ID`. Tenant credentials and preferences are stored in `tenant.model.js` and retrieved dynamically:
- `hubspot.accessToken`, `hubspot.utcOffsetMilliseconds`, `hubspot.portalId`
- `quickbooks.accessToken`, `quickbooks.refreshToken`, `quickbooks.realmId` (auto-refreshed via Axios 401 interceptor)
- `preferences.taxMappings` (HS taxRateGroupId → QB TaxCode ID) — required by invoice sync
- `preferences.depositAccounts` (currency code → QB Bank Account ID) — used by payment sync
- `preferences` may also hold company-wide QB defaults discovered at OAuth (SalesTerm, PaymentMethod, BillEmail) — see `quickbooks.auth.service.js`.

QB tokens are encrypted at rest with `ENCRYPTION_KEY` (AES-256, 64 hex chars).

### Error Handling

`src/utils/axios.error.util.js` exports `extractAxiosError(error)` which parses both QB (`Fault.Error[0]`) and HS (`message`/`errors`) error formats into a readable string. All QB client functions use this — never pass a raw Axios error to `logger.error`.

The logger (`src/lib/logger.lib.js`) has a `safeReplacer` that handles Axios errors and circular references, so `logger.error('msg', error)` is safe but will produce less detail than using `extractAxiosError` explicitly.

**Custom error types** (`src/utils/errors.util.js`):
| Class | Base | Worker outcome |
|---|---|---|
| `AppError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError` | Error / AppError | FAILED (retried) |
| `SkipJobError` | AppError | **SKIPPED** (no retry) |
| `InactiveCustomerError`, `InactiveParentError`, `MissingIdentityError`, `CurrencyMismatchError` | SkipJobError | **SKIPPED** (no retry) |

When adding a new business rule that should abort sync without consuming retries, throw a `SkipJobError` (or a domain-specific subclass).

### Webhook Endpoints & Routing

- `POST /webhook/hubspot-pruebas-testing` — HubSpot events (HMAC validated; bypass flag in dev).
- `POST /webhook/quickbooks-pruebas22` — QuickBooks events (Intuit signature validated; bypass flag in dev).

**HubSpot routing** (`webhook.controller.js`):
- `subscriptionType.startsWith('contact.')` → CONTACT
- `subscriptionType.startsWith('company.')` → COMPANY
- `subscriptionType.startsWith('product.')` → PRODUCT (legacy alias)
- `objectTypeId === '0-7'` → PRODUCT (modern format — HS sends `subscriptionType='object.propertyChange'` for products and the `objectTypeId` is the discriminator)
- `objectTypeId === '0-53'` → INVOICE (also has `hs_balance_due` shield: only dispatches when balance ≤ 0; blocks bare `object.creation`)
- `objectTypeId === '0-101'` → HS_PAYMENT

**QuickBooks routing**: only `Item` and `Customer` entities are processed (mapped to PRODUCT and CONTACT respectively). `Invoice` events are only acted on when `operation='Emailed'`.

### Logs

Winston writes to `logs/app-YYYY-MM-DD.log` (all levels) and `logs/error-YYYY-MM-DD.log` (errors only), JSON format, 14/30-day retention. Console output is human-readable and only active when `NODE_ENV !== 'production'`.

### Environment Variables

Required: `MONGODB_URI`, `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_APP_SECRET`, `QB_SANDBOX_BASE_URL`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`, `QB_REDIRECT_URI`, `ENCRYPTION_KEY` (64 hex chars for AES-256), `DEFAULT_TENANT_ID`.

Optional: `PORT`, `NODE_ENV`, `LOG_LEVEL`, `WORKER_CONCURRENCY` (default 3), `MAX_RETRY_ATTEMPTS`, `INTERNAL_API_KEY`, `ALLOWED_ORIGINS`.

QB tokens (`QB_TEST_ACCESS_TOKEN`, `QB_REALM_ID`) are stored per-tenant in MongoDB and refreshed at runtime — the env vars are only used for initial seeding.

## Scripts

All scripts live in `src/scripts/` and are run via `node src/scripts/<name>.js [flags]`.

### `seed-tenants.js`
One-shot tenant bootstrap. Fetches HS account info via the configured token, creates/upserts the tenant document with HubSpot metadata (portalId, UTC offset). QB credentials are populated separately via the OAuth flow (auth controller hits `/auth/qb/callback`). Run once per new tenant.

### `configure-tax-mappings.js`
Configures `tenant.preferences.taxMappings` (HS `hs_tax_rate_group_id` → QB `TaxCode.Id`). **Required before invoices can sync** — invoice sync throws if not configured.
```bash
node src/scripts/configure-tax-mappings.js --file=tax-mappings.json [--tenant=<tenantId>]
```
JSON format: `{ "<hsTaxRateGroupId>": "<qbTaxCodeId>", ... }`.

### `configure-deposit-accounts.js`
Configures `tenant.preferences.depositAccounts` (ISO currency code → QB Bank `Account.Id`). Used by payment sync to route payments to the correct bank account by currency. If unset, QB falls back to the realm's default deposit account.
```bash
node src/scripts/configure-deposit-accounts.js --file=deposit-accounts.sandbox.json [--tenant=<tenantId>]
```
JSON format: `{ "USD": "<qbAccountId>", "CRC": "<qbAccountId>", ... }`.

### `migrate-qb-contacts.js`
One-shot script that migrates **legacy QB customers** that have `CompanyName` set but no `GivenName`/`FamilyName` (and no `Suffix`). These customers are misclassified as companies by the sync system (`isPerson` check fails) and must be restructured before normal sync can recognize them as contacts.

**What it does per customer:**
1. Checks EntityMapping — skips if already linked.
2. Searches HS by email. If found: updates all QB fields to HS and sets `documento_de_identidad = email.slice(0, 16)`. If not found: creates a new HS contact with QB data.
3. Updates QB customer: `GivenName = CompanyName`, `FamilyName = ''`, `Suffix = email.slice(0, 16)`, `CompanyName = ''`, `DisplayName` updated.
4. Creates EntityMapping with hash matching what `syncCustomerFromQuickbooks` would compute — so the first QB webhook post-migration hits hash-match and skips.

**Dedup logic**: uses the first 16 chars of email as the dedup key (matching the QB Suffix limit). Customers whose `email.slice(0, 16)` collides with another eligible customer are skipped and must be migrated manually.

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

### `reconcile.js`
Audit script. Downloads HS contacts and QB customers, compares paginatedly, and reports gaps. Useful for one-off sync health checks.

## Production Setup Checklist

When promoting a tenant to production with a new client, run in this order:

```bash
# 1. Bootstrap tenant + run OAuth flow to populate QB tokens
node src/scripts/seed-tenants.js
# (then visit the OAuth start URL exposed by the auth controller to authorize QB)

# 2. Configure tax mappings (required for invoice sync)
node src/scripts/configure-tax-mappings.js --file=tax-mappings.json

# 3. Configure deposit accounts (recommended for multi-currency payment routing)
node src/scripts/configure-deposit-accounts.js --file=deposit-accounts.sandbox.json
```

Sample JSON files (`tax-mappings.json`, `deposit-accounts.sandbox.json`) live at the project root. **Both contain real IDs that must come from the client's QB realm** — do not reuse sandbox IDs in production. Re-run either script whenever the client adds a new tax rate / currency / bank account that needs to be wired up.

After all three steps complete, enable the HubSpot and QuickBooks webhook subscriptions pointing at:
- `POST /webhook/hubspot-pruebas-testing`
- `POST /webhook/quickbooks-pruebas22`

Confirm `auth.middleware.js` signature validation is **not** bypassed in the production env (the dev bypass flag must be off).
