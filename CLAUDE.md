# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Development with auto-restart (node --watch)
npm start        # Production start
```

No test suite or linter is configured. There is no build step — this is a plain Node.js CommonJS project.

## Project Structure

```
src/
├── app.js                          # Fastify setup, middleware, route registration
├── server.js                       # Entry point: DB connect → HTTP start → Worker start
├── config/
│   ├── index.js                    # Env validation (fail-fast) + centralized config object
│   └── constants.js                # Enums: JOB_STATUS, SOURCES, ENTITIES, mapped HS props, system props
├── controllers/
│   ├── auth.controller.js          # QuickBooks OAuth flow (connect, callback, status, disconnect)
│   └── webhook.controller.js       # HubSpot + QuickBooks webhook processing → SyncJob creation
├── db/
│   ├── database.js                 # Mongoose connection
│   └── models/
│       ├── entity_mapping.model.js # hsId ↔ qbId relationships + payloadHash + syncToken
│       ├── event_dedup.model.js    # 5-min TTL dedup window for webhook events
│       ├── job.model.js            # SyncJob queue with status lifecycle + 30-day TTL on closed jobs (completed/skipped/dead_letter)
│       ├── oauth_state.model.js    # Anti-CSRF state for OAuth (10-min TTL)
│       ├── sync_audit.model.js     # Audit trail schema (DEFINED BUT UNUSED — see Architecture)
│       └── tenant.model.js         # Multi-tenant config: credentials, preferences, mappings
├── integrations/
│   ├── hubspot/
│   │   └── hubspot.client.js       # HS API client: contacts, companies, products, invoices, payments, associations
│   └── quickbooks/
│       ├── quickbooks.client.js    # QB API client: customers, items, invoices, payments + auto-refresh on 401
│       └── quickbooks.mapper.js    # QB invoice/line-item payload construction
├── lib/
│   ├── crypto.lib.js               # AES-256-GCM encrypt/decrypt for tokens at rest
│   ├── logger.lib.js               # Winston daily-rotate logger with safe Axios error serialization
│   └── response.lib.js             # Standardized JSON response helpers
├── middlewares/
│   ├── api-key.middleware.js        # x-api-key validation (timing-safe compare) for auth endpoints
│   ├── auth.middleware.js           # HMAC signature validation for HS (v3/v1) and QB webhooks
│   └── correlation.middleware.js    # x-correlation-id propagation (UUID v4 fallback)
├── routes/
│   ├── auth.routes.js               # OAuth + connection management routes
│   ├── static.routes.js             # Privacy policy + EULA pages (required by Intuit app listing)
│   └── webhook.routes.js            # Webhook route registration with signature middleware
├── scripts/
│   ├── configure-deposit-accounts.js
│   ├── configure-tax-mappings.js
│   ├── migrate-qb-contacts.js       # V1: link or create HS contacts from legacy QB customers
│   ├── seed-tenants.js
│   └── v2-migrate-contacts-qb.js    # V2: link-only (no HS creation), with built-in retry
├── services/
│   ├── auth.service.js              # Token management, OAuth exchange, refresh with concurrency guard
│   ├── company.sync.service.js
│   ├── contact.sync.service.js
│   ├── dedupe.service.js            # SHA256-based event dedup (5-min window)
│   ├── invoice.sync.service.js
│   ├── job.service.js               # Job CRUD + dedup at intake + retry scheduling
│   ├── mapping.service.js           # EntityMapping upsert/lookup
│   ├── payment.sync.service.js
│   └── product.sync.service.js
├── tasks/
│   └── worker.js                    # V2.0 pull-based motor: concurrent job processing + retry poller
└── utils/
    ├── axios.error.util.js          # Extracts readable errors from QB Fault / HS error responses
    ├── backoff.util.js              # Exponential backoff + retryable error classification
    ├── date.util.js                 # Timezone-aware date formatting (HS UTC → QB local date)
    ├── echo.suppression.util.js     # In-memory TTL sets to prevent sync loops
    ├── errors.util.js               # Custom error hierarchy (AppError, SkipJobError, etc.)
    └── mutex.util.js                # Promise-based per-key sequential execution
```

**Root-level files:** `Dockerfile`, `docker-compose.yml`, `.env.example`, `deposit-accounts.example.json`, `tax-mappings.example.json`.

**Config directory:** `config/deposit-accounts.json`, `config/tax-mappings.json` (active config files used by scripts).

## Architecture Overview

This is a **bidirectional sync integration** between HubSpot (CRM) and QuickBooks (accounting), built with Fastify + MongoDB. It is **not** a REST API — it exposes only webhook endpoints, OAuth endpoints, and static pages. Everything is processed asynchronously via a job queue.

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

**Job Queue is MongoDB-backed** (`src/db/models/job.model.js`). Jobs persist across restarts. The worker (`src/tasks/worker.js`) fetches `PENDING` jobs (`find`) and marks each `PROCESSING` via `findByIdAndUpdate(_id)`. Note: this claim is **not** conditional on status (there is no `{ _id, status: PENDING }` guard), so it is only safe for a **single worker process** — the in-process `activeJobs` slot counter prevents over-subscription, but running multiple worker instances could double-claim a job. A MongoDB Change Stream wakes the worker on new inserts. Orphaned PROCESSING jobs are recovered to **PENDING** on startup.

**Worker V2.0 (pull-based motor)**: processes up to `CONCURRENCY` jobs simultaneously. When a slot frees up, `processNextJobs()` recursively checks for more work. The retry poller runs every 30 seconds, promoting `RETRY_PENDING` jobs back to `PENDING` once their `nextRetryAt` has passed.

**Retry system**: failed jobs go to `RETRY_PENDING` (if retryable) or `DEAD_LETTER` (if max attempts reached or non-retryable). Retryable errors: 408, 409, 429, 5xx, network errors. Non-retryable: 400, 401, 403, 404, 422. Max 3 attempts by default (`MAX_RETRY_ATTEMPTS` env). Exponential backoff: `2^attempts * 1000ms + jitter`.

**SkipJobError** (`src/utils/errors.util.js`): a special error class that signals a business-rule abort, not a failure. The worker catches it and marks the job as **SKIPPED** (not FAILED) so it is not retried. All domain-specific error subclasses extend it: `InactiveCustomerError`, `InactiveParentError`, `MissingIdentityError`, `MissingNitError`, `CurrencyMismatchError`. Throw one of these (or a base `SkipJobError`) when you want to bail out of sync without consuming retries.

**Echo suppression** (`src/utils/echo.suppression.util.js`): when the sync writes back to HS or QB, it marks those IDs in-memory so the resulting webhook doesn't create a loop. TTLs are asymmetric: 10s for HS marks (HS is near-instant), 30s for QB marks (QB batches).

**Mutex per entity** (`src/utils/mutex.util.js`): the worker wraps jobs with a per-entity-ID mutex (`runSequentially(key, fn)`) to prevent concurrent writes to the same record. `contact.sync.service.js` has an additional in-process `_contactLocks` Map for the same contact being processed by concurrent jobs — the second call awaits the first's promise and reuses its result so downstream callers (e.g., invoice sync) get a consistent `contactInfo`/`status`. Invoice creation also uses `runSequentially('invoice-create:${tenantId}', ...)` to serialize DocNumber assignment.

**EntityMapping** (`src/db/models/entity_mapping.model.js`): the source of truth for `hsId ↔ qbId` relationships. Has unique indexes on `(tenantId, entityType, hsId)` and `(tenantId, entityType, qbId)`. When a mapping exists, the sync skips re-resolution in the other platform.

**Hash-based idempotency**: each mapping stores an MD5 hash of the last synced payload. If the hash matches on the next event, the external API call is skipped entirely.

**Hash format mismatch between directions**: HS→QB and QB→HS compute the hash over different JSON structures (different field names — QB-shape vs HS-shape). The first cross-direction event after a write always sees a hash mismatch and triggers an update on the other platform. This is harmless when data is already aligned (the update is a no-op) and echo suppression prevents the resulting webhook from looping back. After that first cross-direction event, the hash stabilizes for its direction.

**Event deduplication** (`src/services/dedupe.service.js`): every incoming webhook event is hashed (sha256 of payload, first 16 chars) and stored in `event_dedup` collection (5-min TTL). Identical re-deliveries from HS/QB are dropped at the gate before a job is created.

**Sync audit trail** (`src/db/models/sync_audit.model.js`): a `SyncAudit` schema (entity, action created/updated/skipped/suppressed/failed, source/target, description, duration; indexed by `(tenantId, createdAt desc)`) **is defined but not currently wired** — no code imports or writes to it, so the collection stays empty. Sync activity today is traced only through the Winston logs and the `status`/`lastError` fields on `syncjobs`. Implementing or removing this model is a pending item.

**Timezone-aware dates** (`src/utils/date.util.js`): HubSpot sends UTC timestamps representing "end of day" in the client's timezone. `formatToQbDate` applies the tenant's `utcOffsetMilliseconds` before formatting to `YYYY-MM-DD`, preventing off-by-one date errors.

### Sync Logic per Entity

**Contacts / Companies** (`contact.sync.service.js`, `company.sync.service.js`):

- **Identity key for contacts**: `documento_de_identidad` (HS custom property) ↔ `Suffix` (QB field). This field is **mandatory** — contacts without it throw `MissingIdentityError` and the job is marked SKIPPED. Never reaches QB.
- **QB `Suffix` field is limited to 16 characters** (hard QB API limit). `normalizeHsContactToQb` truncates `documento_de_identidad` to 16 chars via `.substring(0, 16)`. `createCustomer` and `updateCustomer` in `quickbooks.client.js` apply the same truncation.
- QB `DisplayName` for contacts is built as `"${firstname} ${lastname} ${documento_de_identidad}"` (truncated suffix included to guarantee uniqueness across same-name customers).
- HS → QB: lookup by EntityMapping → fallback `findCustomerBySuffix` (LIKE on DisplayName + client-side filter on exact Suffix, since QB's `Suffix` is not queryable server-side) → create.
- QB → HS: lookup by EntityMapping → fallback `searchContactByIdentification` (searches by `documento_de_identidad`) → create. If QB `Suffix` is empty, the contact is skipped with a warning.
- `processContact` returns `{ qbCustomerId, contactInfo, status }`. `contactInfo` is consumed by `mapInvoicePayload` to set `BillAddr` on QB invoices; `status` is consumed by invoice/payment sync for fail-fast on inactive customers.
- Sub-customers in QB (Job=true or ParentRef) map to HS contacts associated to a company.
- **Identity key for companies**: `nit` (HS custom property) ↔ `AlternatePhone.FreeFormNumber` (QB field). This field is **mandatory** — companies without it throw `MissingNitError` and the job is marked SKIPPED. Never reaches QB.
- QB `DisplayName` for companies is built as `"${companyName} ${nit}"` (nit included to enable LIKE-based search, same strategy as contacts with documento_de_identidad).
- HS → QB: lookup by EntityMapping → fallback `findCompanyByNit` (LIKE on DisplayName + client-side filter on exact AlternatePhone.FreeFormNumber) → create.
- QB → HS: lookup by EntityMapping → fallback `searchCompanyByNit` (searches by `nit` property in HS) → create. If QB `AlternatePhone` is empty, the company is skipped with a warning.
- **Company domain normalization** (QB→HS): WebAddr URI is stripped of protocol and trailing slash, lowercased.
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
- HS → QB: only fires when `hs_balance_due = 0` AND `hs_amount_billed > 0` (the webhook controller enforces balance=0; the service enforces amount>0 to guard against premature events when adding 0% tax items that briefly set balance to 0 before the invoice is finalized).
- **Two-layer currency validation** (fail-fast, no QB call if any layer fails):
  1. **HS-vs-HS** (cheap, no APIs): `hsInvoice.hs_currency` must equal `contactInfo.preferredCurrency`.
  2. **HS-vs-QB**: `hsInvoice.hs_currency` must equal `qbCustomer.CurrencyRef.value` (in case a drift fix hadn't run yet).
  Both throw `CurrencyMismatchError` with actionable text so the user knows how to fix the data. Job marked SKIPPED.
- **Per-line tax**: each invoice line inherits the QB product's `SalesTaxCodeRef` as its `TaxCodeRef` (via `mapLineItemToQb`), and the document uses `GlobalTaxCalculation=TaxExcluded`, so QB adds tax on top per that code. The HS line property `hs_tax_rate_group_id` is **no longer validated nor used** — the former `validateLineTax` check was removed. **Operational precondition:** every QB product must use a 0% sales tax code so QB adds nothing and HS/QB totals match. There is no code enforcement of the 0% rate; the only surviving guard requires the QB item to have *some* `SalesTaxCodeRef`.
- **Inactive customer fail-fast**: throws `InactiveCustomerError` before hitting QB.
- **Manual DocNumber generation**: when QB has "Custom Transaction Numbers" enabled, QB does NOT auto-number. We compute the next DocNumber via `computeNextDocNumber({ lastNumber, paddingLength })` which preserves zero-padding (e.g., `"00045"` → `"00046"`). Reads the previous via `quickbooksClient.getLastInvoiceDocNumber()`. The whole create call is wrapped in `runSequentially('invoice-create:${tenantId}', ...)` to prevent two workers from computing the same number simultaneously and one failing with "Duplicate DocNumber".
- `resolveQbItemIdForLineItem()` tries 3 paths: (1) `id_producto_quickbooks` on the line item (validated for active status), (2) `hs_product_id` → processProduct, (3) name search → create fallback.
- After creating the QB invoice, `reconcilePaymentsForInvoice()` links any existing unlinked QB payments by `PaymentRefNum`.
- The mapper inherits QB company preferences (`SalesTermRef`, `PaymentMethodRef`, `BillEmail`) from `getCompanyPreferences()` so invoices match the tenant's QB defaults. Currency is inherited from the QB customer (`CurrencyRef`), not from HS.
- After successful create, writes `id_factura_quickbooks`, `numero_factura_qb`, and status back to the HS invoice.
- QB → HS: only on `operation=Emailed`, marks HS invoice as paid.

**Payments** (`payment.sync.service.js`):
- HS → QB: creates an Unapplied Payment in QB against the resolved customer (no invoice link at creation).
- **Required invoice association**: payment MUST be associated to at least 1 invoice in HS. If none, throws `CurrencyMismatchError` with a message to register from invoice details. If multiple, validates all share the same currency.
- **Multi-layer currency validation** (same approach as invoices):
  1. Contact's `moneda_de_preferencia` must match invoice currency.
  2. QB customer's `CurrencyRef` must match.
  3. All associated invoices must share the same `hs_currency`.
- **DepositToAccountRef routing**: payments are deposited into the QB account configured for the payment's currency in `tenant.preferences.depositAccounts` (e.g., `{ "USD": "1150040004", "CRC": "1150040003" }`). If no mapping exists for the currency, QB uses the realm's default deposit account and a warning is logged.
- Reconciliation between payment and invoice happens inside `syncInvoiceToQuickbooks` after invoice creation — `reconcilePaymentsForInvoice()` searches by `PaymentRefNum` and calls `linkPaymentToInvoice()`.
- Payments with amount ≤ 0 are silently skipped.

### Multi-Tenancy

The system is designed for multiple tenants but currently runs with `DEFAULT_TENANT_ID`. Tenant credentials and preferences are stored in `tenant.model.js` and retrieved dynamically:
- `hubspot.accessTokenEncrypted`, `hubspot.utcOffsetMilliseconds`, `hubspot.portalId`
- `quickbooks.accessTokenEncrypted`, `quickbooks.refreshTokenEncrypted`, `quickbooks.realmId` (auto-refreshed via Axios 401 interceptor with concurrency guard — multiple 401s share a single refresh promise per tenant)
- `preferences.taxMappings` (HS taxRateGroupId → QB TaxCode ID) — **vestigial** (no longer read by invoice sync as of 2026-06-16)
- `preferences.depositAccounts` (currency code → QB Bank Account ID) — used by payment sync
- `preferences` may also hold company-wide QB defaults discovered at OAuth (SalesTerm, PaymentMethod, BillEmail) — see `auth.service.js`.

QB tokens are encrypted at rest with `ENCRYPTION_KEY` (AES-256-GCM, 64 hex chars).

### Error Handling

`src/utils/axios.error.util.js` exports `extractAxiosError(error)` which parses both QB (`Fault.Error[0]`) and HS (`message`/`errors`) error formats into a readable string. Includes Intuit `intuit_tid` header for audit trails. All QB client functions use this — never pass a raw Axios error to `logger.error`.

The logger (`src/lib/logger.lib.js`) has a `safeReplacer` that handles Axios errors and circular references, so `logger.error('msg', error)` is safe but will produce less detail than using `extractAxiosError` explicitly.

**Custom error types** (`src/utils/errors.util.js`):
| Class | Base | Worker outcome |
|---|---|---|
| `AppError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError` | Error / AppError | FAILED (retried) |
| `SkipJobError` | AppError | **SKIPPED** (no retry) |
| `InactiveCustomerError`, `InactiveParentError`, `MissingIdentityError`, `MissingNitError`, `CurrencyMismatchError` | SkipJobError | **SKIPPED** (no retry) |

When adding a new business rule that should abort sync without consuming retries, throw a `SkipJobError` (or a domain-specific subclass).

### Webhook Endpoints & Routing

- `POST /webhook/hubspot` — HubSpot events (HMAC validated via `x-hubspot-signature-v3` preferred, `v1` fallback; 5-min anti-replay window; bypass in dev/test).
- `POST /webhook/quickbooks` — QuickBooks events (Intuit signature validated; bypass in dev/test). Supports both **legacy** `eventNotifications` format and **CloudEvents** format (`application/cloudevents+json`, `application/cloudevents-batch+json`) which becomes mandatory after July 2026.

**HubSpot routing** (`webhook.controller.js`):
- `subscriptionType.startsWith('contact.')` → CONTACT
- `subscriptionType.startsWith('company.')` → COMPANY
- `subscriptionType.startsWith('product.')` → PRODUCT (legacy alias)
- `objectTypeId === '0-7'` → PRODUCT (modern format — HS sends `subscriptionType='object.propertyChange'` for products and the `objectTypeId` is the discriminator)
- `objectTypeId === '0-53'` → INVOICE (also has `hs_balance_due` shield: only dispatches when balance ≤ 0; blocks bare `object.creation`)
- `objectTypeId === '0-101'` → HS_PAYMENT

**QuickBooks routing**: `Customer`, `Item`, and `Invoice` entities are processed. In `QB_ENTITY_MAP`, `Customer` maps to **CONTACT** and `Item` to PRODUCT; the CONTACT-vs-COMPANY disambiguation happens **downstream** in `contactSyncService.syncCustomerFromQuickbooks`, which inspects `isPerson`/sub-customer and delegates to `companySyncService.syncCompanyFromQuickbooks` when the QB customer is actually a company. `Invoice` events are only acted on when `operation='Emailed'`.

### Auth & OAuth Endpoints

All under `/auth/quickbooks/` prefix, managed by `auth.controller.js`:

- `GET /auth/quickbooks/connect` (API key required) — Generates OAuth URL with anti-CSRF `state` (stored in `oauth_state` collection, 10-min TTL). Returns Intuit authorization URL.
- `GET /auth/quickbooks/callback` (public) — Intuit redirects here after user authorization. Validates `state` (atomic delete = one-time use), exchanges `code` for tokens via `authService.exchangeCodeForTokens()`, stores encrypted tokens in tenant.
- `GET /auth/quickbooks/status` (API key required) — Returns connection status, token expiration times, environment (sandbox/production).
- `POST /auth/quickbooks/disconnect` (API key required) — Clears QB tokens from tenant (does not delete tenant).
- `GET /auth/quickbooks/disconnected` (public) — Landing page displayed when user disconnects from QB's settings UI.
- `GET /privacy` (public) — Privacy policy page (required by Intuit app listing).
- `GET /eula` (public) — EULA page (required by Intuit app listing).

### HTTP Middleware Stack

Applied globally via `app.js`:
1. **Raw body preservation** — Custom JSON parser stores raw body for HMAC signature validation.
2. **Correlation ID** (`correlation.middleware.js`) — Propagates `x-correlation-id` header or generates UUID v4. Returned in response headers.
3. **Helmet** — Security headers (CSP disabled).
4. **CORS** — Currently `cors({ origin: true })` (reflects any origin). The `ALLOWED_ORIGINS` env var is parsed in config but **not wired** to CORS yet.
5. **Compression** — gzip/deflate response compression.
6. **Rate limiting** — 100 requests per minute per IP.
7. **API key validation** (`api-key.middleware.js`) — Applied to `/auth/quickbooks/connect`, `/status`, `/disconnect`. Uses `crypto.timingSafeEqual` to prevent timing attacks.
8. **Webhook signature validation** (`auth.middleware.js`) — Applied per webhook route. Bypassed in `development` and `test` environments.

### Logs

Winston writes to `logs/app-YYYY-MM-DD.log` (all levels, 14-day retention, 20MB max per file) and `logs/error-YYYY-MM-DD.log` (errors only, 30-day retention), JSON format. Exception and rejection handlers have 30-day retention. Console transport is always active (critical for container environments where stdout is the log source).

### Environment Variables

**Always required** (fail-fast on startup): `MONGODB_URI`, `HUBSPOT_ACCESS_TOKEN`, `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `ENCRYPTION_KEY` (64 hex chars for AES-256), `INTERNAL_API_KEY`.

**Required in production only**: `HUBSPOT_APP_SECRET`, `QB_WEBHOOK_VERIFIER_TOKEN`. In dev/test environments, webhook signature validation is bypassed.

**Optional**: `PORT` (default 3001), `NODE_ENV` (default development), `LOG_LEVEL` (default info), `WORKER_CONCURRENCY` (default 3), `MAX_RETRY_ATTEMPTS` (default 3), `ALLOWED_ORIGINS`, `QB_SANDBOX_BASE_URL`, `QB_REDIRECT_URI`.

**Initial seeding only** (read from env but stored per-tenant in MongoDB after OAuth): `QB_TEST_ACCESS_TOKEN`, `QB_REALM_ID`.

### Docker

The project includes a `Dockerfile` and `docker-compose.yml` for containerized deployment.

### Constants Reference

`src/config/constants.js` defines:
- **Job statuses**: `pending`, `processing`, `completed`, `failed`, `retry_pending`, `suppressed`, `skipped`, `dead_letter`.
- **Sources**: `HUBSPOT`, `QUICKBOOKS`, `INTERNAL`.
- **Entities**: `contact`, `company`, `product`, `invoice`, `payment`, `line_item`, `hs_payment`.
- **Contact status property**: `estado_del_contacto_qb` with values `active`/`inactive`.
- **`MAPPED_HS_PROPS`**: properties per entity that trigger sync on change (contact: 11 props, company: 9 props, product: 7 props).
- **`HS_SYSTEM_PROPS`**: properties written by the sync itself, ignored in webhooks to suppress echoes (11 props including `id_usuario_quickbooks`, `id_producto_quickbooks`, `numero_factura_qb`, etc.).

## Scripts

All scripts live in `src/scripts/` and are run via `node src/scripts/<name>.js [flags]`.

### `seed-tenants.js`
One-shot tenant bootstrap. Fetches HS account info via the configured token, creates/upserts the tenant document with HubSpot metadata (portalId, UTC offset). QB credentials are populated separately via the OAuth flow (`GET /auth/quickbooks/connect` → callback). Run once per new tenant.

### `configure-tax-mappings.js`
Configures `tenant.preferences.taxMappings` (HS `hs_tax_rate_group_id` → QB `TaxCode.Id`). **Vestigial:** as of 2026-06-16 invoice sync no longer reads `taxMappings` (the per-line tax validation was removed). This script and the field are kept but no longer affect invoice tax behavior. Shows diff of current vs. desired state and prompts for confirmation before applying.
```bash
node src/scripts/configure-tax-mappings.js --file=tax-mappings.json [--tenant=<tenantId>]
```
JSON format: `{ "<hsTaxRateGroupId>": "<qbTaxCodeId>", ... }`.

### `configure-deposit-accounts.js`
Configures `tenant.preferences.depositAccounts` (ISO currency code → QB Bank `Account.Id`). Used by payment sync to route payments to the correct bank account by currency. If unset, QB falls back to the realm's default deposit account. Shows diff and prompts for confirmation.
```bash
node src/scripts/configure-deposit-accounts.js --file=deposit-accounts.json [--tenant=<tenantId>]
```
JSON format: `{ "USD": "<qbAccountId>", "CRC": "<qbAccountId>", ... }`.
Validation: currency codes must be exactly 3 uppercase letters; account IDs must be non-empty strings.

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

**Output**: generates JSON report + CSV of skipped/failed records in `./migration-reports/`. Throttles at 500ms per customer.

### `v2-migrate-contacts-qb.js`
V2 variant of the migration script. Key difference: if a QB customer's email is **not found** in HubSpot, it is **skipped** (no HS contact creation). V1 creates a new HS contact; V2 only links existing ones.

Includes built-in retry logic (`withRetry`) for 429/5xx/network errors with exponential backoff. Same flags as V1:
```bash
node src/scripts/v2-migrate-contacts-qb.js --dry-run
node src/scripts/v2-migrate-contacts-qb.js --limit=5
node src/scripts/v2-migrate-contacts-qb.js
```

Output in `./migration-reports/v2-migration-{timestamp}.json` and `.csv`. Additional report section: `skippedNotInHs[]`.

## Production Setup Checklist

When promoting a tenant to production with a new client, run in this order:

```bash
# 1. Bootstrap tenant + run OAuth flow to populate QB tokens
node src/scripts/seed-tenants.js
# (then visit GET /auth/quickbooks/connect?tenantId=... to start OAuth)

# 2. Configure tax mappings (required for invoice sync)
node src/scripts/configure-tax-mappings.js --file=config/tax-mappings.json

# 3. Configure deposit accounts (recommended for multi-currency payment routing)
node src/scripts/configure-deposit-accounts.js --file=config/deposit-accounts.json
```

Example JSON files live in `config/` and at the project root (`deposit-accounts.example.json`, `tax-mappings.example.json`). **Both contain real IDs that must come from the client's QB realm** — do not reuse sandbox IDs in production. Re-run either script whenever the client adds a new tax rate / currency / bank account that needs to be wired up.

After all three steps complete, enable the HubSpot and QuickBooks webhook subscriptions pointing at:
- `POST /webhook/hubspot`
- `POST /webhook/quickbooks`

Confirm `auth.middleware.js` signature validation is **not** bypassed in the production env (the dev bypass flag must be off).
