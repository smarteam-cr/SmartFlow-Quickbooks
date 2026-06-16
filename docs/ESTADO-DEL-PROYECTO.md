# Estado del Proyecto — SmartFlow-Quickbooks

Notas de traspaso para el equipo de desarrollo: estado de la entrega de código, pendientes, riesgos, mejoras, incidencias conocidas y dependencias con terceros. Para instalar y ejecutar ver [`../README.md`](../README.md); para el diseño interno y los diagramas, [`./ARQUITECTURA.md`](./ARQUITECTURA.md); referencia técnica exhaustiva en [`../CLAUDE.md`](../CLAUDE.md).

---

## 1. Entrega de código fuente

- [x] **Código fuente completo** en `src/` (Node.js CommonJS; sin build, sin tests, sin linter).
- [x] **Archivos de configuración de ejemplo** versionados: `deposit-accounts.example.json`, `tax-mappings.example.json`.
- [x] **Variables de entorno documentadas** en [`../.env.example`](../.env.example) (las 19, agrupadas y comentadas, **sin credenciales**).
- [x] **Dependencias** fijadas en `package.json` + `package-lock.json` (`npm ci --omit=dev` respeta el lock).
- [x] **README** con instalación y ejecución.
- [x] **Sin cambios solo-locales**: la rama `main` debe reflejar el estado entregado (commitear el árbol de trabajo antes de cerrar).

> **No se versiona (seguridad):** `.env`, `.env.prod` y `config/` están en `.gitignore`; se entregan los `*.example`. Nunca poner valores reales en los `*.example`. La `ENCRYPTION_KEY` y los tokens cifrados se resguardan **fuera** del repositorio.

**Repositorio:** `git@github.com:smarteam-cr/SmartFlow-Quickbooks.git` — branch `main`.

---

## 2. Tareas pendientes

- **Resolución de tenant por webhook.** Hoy `tenantId` se fija estático a `DEFAULT_TENANT_ID`; multi-cliente real requiere derivarlo del payload.
- **Limpiar ruido de debug:** dos `console.log` separadores en `webhook.controller.js` (líneas 19 y 116) → `logger.debug` o eliminar.
- **Deprecar `taxMappings`** (vestigial desde 2026-06-16): el script `configure-tax-mappings.js`, el campo `tenant.preferences.taxMappings` y `tax-mappings.example.json` ya no afectan el cálculo de impuestos.

---

## 3. Riesgos identificados

- **Sin tests, linter ni CI.** Toda la lógica crítica se valida solo manualmente.
- **MongoDB debe ser replica set (`rs0`).** Si `MONGODB_URI` apunta a un standalone, el worker (`SyncJob.watch`, Change Streams) falla y los jobs **no se procesan** aunque la app arranque.
- **CORS abierto:** `app.js` registra `cors({ origin: true })`; `ALLOWED_ORIGINS` se parsea pero **no está cableada**.
- **Bypass de firma de webhooks en dev/test.** En un servidor expuesto, `NODE_ENV` **debe** ser `production`, o cualquiera podría enviar webhooks falsos.
- **`DEFAULT_TENANT_ID` con fallback hardcodeado** `cliente-oficial-1` (`constants.js`). Si se deja vacía, los webhooks crean jobs para un tenant inexistente sin error de arranque.
- **`ENCRYPTION_KEY` (AES-256-GCM, 64 hex):** si se pierde, los tokens QB cifrados quedan irrecuperables (rehacer OAuth). No hay procedimiento de rotación.
- **Tokens de terceros:** el refresh token de QuickBooks vence a ~100 días de inactividad (rehacer OAuth); el token de HubSpot es de app privada estático, sin refresco — si se revoca, la sincronización se detiene. No hay alerta de expiración.
- **DocNumber manual** (cuando QB usa "Custom Transaction Numbers"): serializado con un mutex **in-memory**; con más de una instancia volverían los duplicados.
- **Precondición de impuesto 0% no forzada por código:** todo producto en QB debe usar un código de impuesto al 0% o los totales HS/QB se descuadran silenciosamente.
- **Worker in-process:** corre dentro del proceso de la API; un crash en el procesamiento tumba también los webhooks. El escalado horizontal está limitado por los mutex in-memory.
- **`CurrencyRef` de QB es inmutable** tras crear el customer: una moneda equivocada solo se corrige recreando el cliente en QB.

---

## 4. Mejoras sugeridas

- **Añadir tests** (al menos unit de funciones puras: DocNumber/padding, normalización de estado, fechas timezone, clasificación de reintentos, hashing de idempotencia) + script `npm test`. **Mayor impacto** dado que hoy no hay red de seguridad.
- Añadir `engines` (`node >=24`) y un linter/format a `package.json`.
- Alerta proactiva de expiración de tokens (refresh de QB + token de HubSpot).
- Lock distribuido para el DocNumber (o contador atómico en Mongo) si se escala a varias instancias.
- Forzar/alertar la precondición de impuesto 0% en productos QB.
- Separar worker y API en procesos/containers distintos; exponer un `/health` que verifique Mongo + replica set.
- Cablear `ALLOWED_ORIGINS` para cerrar CORS.

---

## 5. Incidencias conocidas

- **Contactos/empresas sin campo de identidad** (`documento_de_identidad` / `nit`) **nunca llegan a QB**: el job se marca SKIPPED (no FAILED). El usuario cree que sincronizaron y no es así.
- **Facturas:** solo sincronizan HS→QB con `hs_balance_due=0` **y** `hs_amount_billed>0` (totalmente pagadas). Si la moneda no cuadra → SKIPPED con `CurrencyMismatchError`.
- **Pagos:** requieren al menos una factura asociada en HS o se rechazan; monto ≤0 se omite silenciosamente.
- **Sub-clientes con moneda distinta a la empresa madre:** QB rechaza el `ParentRef`; el contacto se crea como cliente independiente (la asociación se conserva en HubSpot). Solo se corrige a mano en QB.
- **`Suffix` de QB limitado a 16 caracteres:** `documento_de_identidad` se trunca; dos documentos con los primeros 16 chars iguales colisionan.
- **Hash de idempotencia con formato distinto por dirección** (HS→QB vs QB→HS): el primer evento cross-dirección dispara un update no-op. Conocido y aceptado, **no es un bug**.
- **Migraciones legacy** (`migrate-qb-contacts.js`, `v2-migrate-contacts-qb.js`): hacen escrituras **irreversibles** en QB/HS; el rollback solo restaura `EntityMapping`. Exigen webhooks apagados y cola de jobs vacía.

---

## 6. Dependencias con terceros

- **HubSpot (CRM):** token de **app privada estático** (`HUBSPOT_ACCESS_TOKEN`), sin refresh. Webhooks firmados con `HUBSPOT_APP_SECRET`.
- **QuickBooks Online / Intuit:** **OAuth 2.0** (`QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI` exacto). El registro de la app de producción en el **Intuit Developer Portal** es **bloqueante** (revisión de Intuit: días/semanas). Webhooks validados con `QB_WEBHOOK_VERIFIER_TOKEN`.
- **MongoDB** como **replica set `rs0`** (obligatorio por los Change Streams del worker).
- **Runtime/librerías:** Node.js 24, Fastify 5 (+ helmet/cors/compress/rate-limit), Mongoose 9, axios, winston, zod, uuid, dotenv. Dependencias en `^` (revisar el lockfile periódicamente).
- Inventario completo de variables de entorno: ver [`../.env.example`](../.env.example).

---

## 7. Documentación extra y notas críticas

- **Replica set obligatorio** (Change Streams): sin él los jobs no se procesan.
- **Ambientes de QuickBooks:** `QB_SANDBOX_BASE_URL` define sandbox vs producción (el nombre es legado; aplica a ambos).
- **Firmas de webhooks:** en `NODE_ENV=development|test` se omiten; en producción `NODE_ENV=production`.
- **Impuesto 0%** en productos QB: precondición operativa sin enforcement en código.
- **`taxMappings` vestigial** desde 2026-06-16 (el invoice sync ya no lo lee).
- **Auditoría sin implementar:** el modelo `sync_audit` (`SyncAudit`) está definido pero **ningún código escribe en él**; la colección queda vacía. La trazabilidad real son los logs de Winston y el `status`/`lastError` de `syncjobs`. Implementarlo o eliminarlo.
- **Puesta en producción:** pasos resumidos en el README (sección "Puesta en producción") y checklist en [`../CLAUDE.md`](../CLAUDE.md) (*Production Setup Checklist*).
