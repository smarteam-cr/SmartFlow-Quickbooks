# SmartFlow-Quickbooks

Integración de **sincronización bidireccional** entre **HubSpot** (CRM) y **QuickBooks Online** (contabilidad). El sistema escucha los webhooks de ambas plataformas, encola cada cambio como un *job* en MongoDB y un *worker* los procesa de forma asíncrona, manteniendo alineados contactos, empresas, productos, facturas y pagos en las dos direcciones.

No es una API REST: solo expone endpoints de webhooks, el flujo OAuth de QuickBooks y un par de páginas estáticas requeridas por Intuit. Toda la lógica de negocio se ejecuta en segundo plano.

> Para la referencia técnica profunda consulta [`CLAUDE.md`](CLAUDE.md) y [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md). Para las reglas de negocio por entidad y el troubleshooting de usuario final, la [Guía de Usuario](docs/Guia-de-Usuario-Integracion-HubSpot-QuickBooks.md).

---

## Tabla de contenidos

1. [Características principales](#1-características-principales)
2. [Stack tecnológico](#2-stack-tecnológico)
3. [Servicios externos requeridos](#3-servicios-externos-requeridos)
4. [Requisitos previos](#4-requisitos-previos)
5. [Instalación](#5-instalación)
6. [Variables de entorno](#6-variables-de-entorno)
7. [Ejecución local](#7-ejecución-local)
8. [Ejecución con Docker](#8-ejecución-con-docker)
9. [Ambientes disponibles](#9-ambientes-disponibles)
10. [Estructura del proyecto](#10-estructura-del-proyecto)
11. [Scripts](#11-scripts)
12. [Endpoints expuestos](#12-endpoints-expuestos)
13. [Puesta en producción](#13-puesta-en-producción)
14. [Documentación adicional](#14-documentación-adicional)
15. [Licencia](#15-licencia)

---

## 1. Características principales

La integración sincroniza cinco entidades. La mayoría son **bidireccionales** (un cambio en cualquiera de las dos plataformas se propaga a la otra); las facturas y los pagos son **unidireccionales** salvo el caso indicado.

| Entidad | Dirección | Notas |
|---|---|---|
| **Contactos** | HubSpot ↔ QuickBooks | Identidad por `documento_de_identidad` (HS) ↔ `Suffix` (QB). Campo obligatorio. |
| **Empresas** | HubSpot ↔ QuickBooks | Identidad por `nit` (HS) ↔ `AlternatePhone` (QB). Campo obligatorio. |
| **Productos** | HubSpot ↔ QuickBooks | Crear y actualizar en ambos sentidos. Los de tipo *Inventory* solo se gestionan en QB. |
| **Facturas** | HubSpot → QuickBooks | Solo cuando `hs_balance_due = 0` y `hs_amount_billed > 0` (factura totalmente pagada). De QB → HS solo se marca como pagada al evento `Emailed`. |
| **Pagos** | HubSpot → QuickBooks | El pago debe estar asociado a al menos una factura. Ruteo de depósito por moneda. |

Bajo el capó:

- **Cola de jobs respaldada en MongoDB** (colección `syncjobs`) que persiste entre reinicios.
- **Worker pull-based** con concurrencia configurable (default 3) que toma jobs `pending` y se despierta vía **MongoDB Change Streams** (de ahí el requisito de replica set). Diseñado para una sola instancia del worker (ver nota de concurrencia en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md)).
- **Reintentos con backoff exponencial** y máquina de estados: `pending`, `processing`, `completed`, `failed`, `retry_pending`, `suppressed`, `skipped`, `dead_letter`.
- **`SkipJobError`** marca el job como `skipped` (sin reintento) ante reglas de negocio (p. ej. falta de identidad, cliente inactivo, descuadre de moneda).
- **`EntityMapping`** como fuente de verdad de la relación `hsId ↔ qbId`, con **hash de idempotencia** para evitar llamadas API redundantes.
- **Deduplicación de eventos** (ventana TTL de 5 min), **echo suppression** para evitar loops de sincronización y **mutex por entidad** para serializar escrituras al mismo registro.
- **Fechas timezone-aware** y **tokens de QuickBooks cifrados en reposo** (AES-256-GCM) con auto-refresh ante respuestas 401.

---

## 2. Stack tecnológico

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 24 (CommonJS, sin paso de build) |
| Framework HTTP | Fastify 5 (+ `@fastify/helmet`, `cors`, `compress`, `rate-limit`) |
| Base de datos | MongoDB (**replica set** obligatorio) vía Mongoose 9 |
| Cliente HTTP | axios 1.x |
| Logging | winston + winston-daily-rotate-file |
| Validación / utilidades | zod, uuid, dotenv |
| Contenedores | Docker + Docker Compose |

No hay suite de tests, linter ni CI configurados en el proyecto.

---

## 3. Servicios externos requeridos

- **HubSpot (CRM)** — Acceso vía API con un token de **app privada** (`HUBSPOT_ACCESS_TOKEN`, estático, sin refresh). Se reciben sus webhooks en `POST /webhook/hubspot`. La app de HubSpot debe tener configuradas las suscripciones de `contact.*`, `company.*`, productos (`0-7`), facturas (`0-53`) y pagos (`0-101`).
- **QuickBooks Online / Intuit (contabilidad)** — Acceso vía API de Accounting con **OAuth 2.0**. Requiere registrar la app en el **Intuit Developer Portal** para obtener `QB_CLIENT_ID` / `QB_CLIENT_SECRET`. El `access token` dura ~1 h y el `refresh token` ~100 días (ambos cifrados y auto-refrescados). Webhooks en `POST /webhook/quickbooks`.
- **MongoDB** — Debe correr como **replica set (`rs0`)**, no standalone: el worker usa Change Streams para despertarse, y estos requieren replica set.

Detalle de riesgos operativos de cada servicio (expiración de tokens, registro en Intuit, etc.) en [`docs/ESTADO-DEL-PROYECTO.md`](docs/ESTADO-DEL-PROYECTO.md).

---

## 4. Requisitos previos

- **Node.js 24** (el `Dockerfile` usa `node:24-alpine`; no hay campo `engines`, pero es la versión objetivo).
- **MongoDB como replica set `rs0`** (local vía Docker, o un Mongo gestionado tipo Atlas con replica set).
- **Docker / Docker Compose** (opcional, pero es la forma más sencilla de levantar Mongo como replica set).
- Credenciales de **HubSpot** (token de app privada) y de **QuickBooks** (Client ID/Secret de Intuit).
- Una **`ENCRYPTION_KEY`** de exactamente **64 caracteres hexadecimales** (32 bytes, AES-256-GCM). El arranque falla si su longitud no es 64.

---

## 5. Instalación

```bash
git clone git@github.com:smarteam-cr/SmartFlow-Quickbooks.git
cd SmartFlow-Quickbooks
npm install
```

Proyecto CommonJS: sin paso de build, sin test suite y sin linter.

---

## 6. Variables de entorno

Copia el archivo de ejemplo y completa los valores. El archivo `.env` está en `.gitignore` y **no** se versiona.

```bash
cp .env.example .env
```

Genera una `ENCRYPTION_KEY` válida (64 hex) si no la tienes:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Tabla resumen (el detalle y los placeholders viven en [`.env.example`](.env.example)). **Nunca** pongas credenciales reales en `.env.example`.

### Requeridas siempre (fail-fast en el arranque)

| Variable | Descripción |
|---|---|
| `MONGODB_URI` | Cadena de conexión a Mongo; debe apuntar a un replica set (p. ej. `mongodb://localhost:27017/smartflow?replicaSet=rs0`). |
| `HUBSPOT_ACCESS_TOKEN` | Token de acceso de la app privada de HubSpot. |
| `QB_CLIENT_ID` | Client ID de la app de QuickBooks (Intuit Developer). |
| `QB_CLIENT_SECRET` | Client Secret de la app de QuickBooks. |
| `ENCRYPTION_KEY` | Llave AES-256-GCM, exactamente 64 caracteres hex (32 bytes). |
| `INTERNAL_API_KEY` | API key para los endpoints administrativos `/auth/quickbooks/{connect,status,disconnect}` (comparación timing-safe). |

### Requeridas solo en producción (`NODE_ENV=production`)

| Variable | Descripción |
|---|---|
| `HUBSPOT_APP_SECRET` | Secreto para validar la firma HMAC de los webhooks de HubSpot. En dev/test el middleware hace bypass. |
| `QB_WEBHOOK_VERIFIER_TOKEN` | Verifier token de Intuit para validar la firma de los webhooks de QuickBooks. En dev/test hace bypass. |

### OAuth / conexión a QuickBooks

| Variable | Descripción |
|---|---|
| `QB_SANDBOX_BASE_URL` | Base URL de la API de QB. Sandbox: `https://sandbox-quickbooks.api.intuit.com`; producción: `https://quickbooks.api.intuit.com`. El nombre dice "sandbox" por legado, pero aplica a ambos ambientes. |
| `QB_REDIRECT_URI` | Redirect URI del callback OAuth, debe coincidir **exacto** con el registrado en la app de Intuit (incluida la `/` final). |
| `QB_TEST_ACCESS_TOKEN` | Token QB inicial (opcional; normalmente se obtiene vía OAuth). Solo para seeding. |
| `QB_REALM_ID` | Realm ID / Company ID de QuickBooks inicial. Solo para seeding (luego vive por-tenant en Mongo). |

### Opcionales (con valor por defecto)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto HTTP. |
| `NODE_ENV` | `development` | Ambiente de ejecución. |
| `LOG_LEVEL` | `info` | Nivel de logging de winston. |
| `MAX_RETRY_ATTEMPTS` | `3` | Intentos máximos por job antes de `dead_letter`. |
| `WORKER_CONCURRENCY` | `3` | Jobs procesados en paralelo por el worker. |
| `ALLOWED_ORIGINS` | — | Orígenes permitidos para CORS (coma-separados). ⚠️ Hoy se parsea pero **no está cableada**: CORS refleja cualquier origen (`cors({ origin: true })`). Ver riesgos en [`docs/ESTADO-DEL-PROYECTO.md`](docs/ESTADO-DEL-PROYECTO.md). |
| `DEFAULT_TENANT_ID` | — | ID del tenant por defecto (el sistema es multi-tenant pero hoy corre con uno). |

---

## 7. Ejecución local

1. **Levanta MongoDB como replica set `rs0`** (obligatorio: el worker usa Change Streams). La opción más simple es usar los servicios de Mongo del compose:

   ```bash
   docker compose up -d mongodb mongo-init
   ```

   El servicio `mongo-init` ejecuta `rs.initiate()` del replica set `rs0` una sola vez. Como alternativa local, arranca `mongod --replSet rs0 --bind_ip_all` y ejecuta `rs.initiate()` una vez vía `mongosh`.

2. **Apunta `MONGODB_URI`** en `.env` al replica set (p. ej. `mongodb://localhost:27017/smartflow?replicaSet=rs0`).

3. **(Opcional, primera vez) Siembra el tenant**: consulta HubSpot y crea/upsertea el documento del tenant en Mongo. Las credenciales de QuickBooks se obtienen aparte vía OAuth.

   ```bash
   node src/scripts/seed-tenants.js
   ```

4. **Arranca la app en desarrollo** (auto-restart con `node --watch`). En dev la validación de firma de webhooks hace bypass, por lo que `HUBSPOT_APP_SECRET` y `QB_WEBHOOK_VERIFIER_TOKEN` no son requeridos.

   ```bash
   npm run dev
   ```

   Escucha en `http://0.0.0.0:3001` (`PORT` por defecto 3001).

5. **(Opcional) Conecta QuickBooks vía OAuth**: visita `GET /auth/quickbooks/connect` con el header `x-api-key: <INTERNAL_API_KEY>` para obtener la URL de autorización de Intuit. Tras autorizar, Intuit redirige a `GET /auth/quickbooks/callback` y los tokens cifrados quedan en el tenant en Mongo. Verifica con `GET /auth/quickbooks/status`.

6. **(Opcional, multi-moneda) Configura cuentas de depósito**:

   ```bash
   node src/scripts/configure-deposit-accounts.js --file=config/deposit-accounts.json
   ```

Para producción se usa `npm start` (`node src/server.js`), cuyo entrypoint es `connectDB() → app.listen(PORT, '0.0.0.0') → startWorker()`.

| Comando | Qué hace |
|---|---|
| `npm install` | Instala dependencias de producción. Sin paso de build. |
| `npm run dev` | Desarrollo con auto-restart (`node --watch src/server.js`). |
| `npm start` | Producción (`node src/server.js`). |

---

## 8. Ejecución con Docker

Para correr todo el stack en contenedores (app + Mongo replica set), requiere un archivo `.env` presente (se usa como `env_file`):

```bash
docker compose up -d --build
```

Esto construye la imagen (`node:24-alpine`, `npm ci --omit=dev`, usuario `node`, `EXPOSE 3001`) y levanta **3 servicios**:

- **`app`** — el contenedor `smartflow-quickbooks`, publica el puerto `PORT:PORT` (3001) y monta los volúmenes `./logs`, `./migration-reports` y `./config`. Depende de `mongodb` *healthy* y de `mongo-init` completado.
- **`mongodb`** — `mongo:7` como **replica set `rs0`** (`--bind_ip_all`), con healthcheck vía `mongosh` y volumen persistente `mongo-data`.
- **`mongo-init`** — `mongo:7` que ejecuta `rs.initiate()` del replica set una sola vez.

Comandos útiles:

```bash
docker compose ps             # estado de los 3 servicios
docker compose logs -f app    # seguir logs de la app (stdout es la fuente de logs)
docker compose restart app    # reiniciar solo la app
docker compose down           # detener (conserva el volumen mongo-data)
docker compose down -v        # detener y BORRAR el volumen (todos los datos de Mongo)
```

---

## 9. Ambientes disponibles

El comportamiento varía según `NODE_ENV`:

| Ambiente | Firma de webhooks | Notas |
|---|---|---|
| `development` | **Bypass** | `HUBSPOT_APP_SECRET` y `QB_WEBHOOK_VERIFIER_TOKEN` no requeridos. |
| `test` | **Bypass** | Igual que development. |
| `production` | **Validada** | Requiere `HUBSPOT_APP_SECRET` y `QB_WEBHOOK_VERIFIER_TOKEN`. |

El ambiente de QuickBooks (sandbox vs. producción) se controla con `QB_SANDBOX_BASE_URL`:

- **Sandbox:** `https://sandbox-quickbooks.api.intuit.com`
- **Producción:** `https://quickbooks.api.intuit.com`

> Cuidado: dejar `NODE_ENV=development` en un servidor expuesto desactiva la validación de firma de los webhooks. El runbook de producción lo verifica explícitamente.

---

## 10. Estructura del proyecto

```
src/
├── app.js              # Setup de Fastify, middlewares y registro de rutas
├── server.js           # Entrypoint: connectDB → listen → startWorker
├── config/             # Validación de env (fail-fast) y constantes/enums
├── controllers/        # OAuth de QuickBooks y procesamiento de webhooks → SyncJob
├── db/                 # Conexión Mongoose y modelos (jobs, mappings, tenants, etc.)
├── integrations/       # Clientes HTTP de HubSpot y QuickBooks (+ mapper de QB)
├── lib/                # Cripto (tokens), logger winston, helpers de respuesta
├── middlewares/        # API key, firmas HMAC de webhooks, correlation ID
├── routes/             # Webhooks, OAuth/auth y páginas estáticas
├── scripts/            # Seeding, configuración y migración (ver más abajo)
├── services/           # Lógica de sincronización por entidad + jobs/mappings/dedup
├── tasks/              # worker.js — motor pull-based de procesamiento de jobs
└── utils/              # Backoff, fechas, echo suppression, errores, mutex
```

El detalle completo de cada módulo y las decisiones de arquitectura está en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) y [`CLAUDE.md`](CLAUDE.md).

---

## 11. Scripts

### Scripts de npm

| Comando | Descripción |
|---|---|
| `npm run dev` | Desarrollo con auto-restart (`node --watch src/server.js`). |
| `npm start` | Producción (`node src/server.js`). |

### Scripts de Node (`src/scripts/*.js`)

Se ejecutan con `node src/scripts/<nombre>.js [flags]`. El detalle completo de cada uno (preconditions, formato de los JSON, idempotencia) está en [`CLAUDE.md`](CLAUDE.md).

| Script | Propósito | Flags |
|---|---|---|
| `seed-tenants.js` | Bootstrap one-shot del tenant: consulta la cuenta de HubSpot, crea/upsertea el documento del tenant (portalId, zona horaria) y cifra el token. No toca credenciales de QuickBooks (esas se pueblan vía OAuth). | — |
| `configure-deposit-accounts.js` | Configura `preferences.depositAccounts` (moneda ISO → QB Bank Account Id) usado por el payment sync. Muestra diff y pide confirmación. | `--file=<path>` (req.) `[--tenant=<id>]` |
| `configure-tax-mappings.js` | Configura `preferences.taxMappings` (HS `hs_tax_rate_group_id` → QB TaxCode Id). **Vestigial desde 2026-06-16**: el invoice sync ya no lee este campo. | `--file=<path>` (req.) `[--tenant=<id>]` |
| `migrate-qb-contacts.js` | Migración one-shot QB→HS (V1) del cohort legacy de contactos: enlaza o crea en HS y reestructura el QB customer. Genera reporte JSON+CSV en `./migration-reports/`. | `[--dry-run] [--limit=N]` |
| `v2-migrate-contacts-qb.js` | Migración V2: solo **enlaza** contactos existentes en HS (si el email no existe en HS, se omite). Incluye retry con backoff. | `[--dry-run] [--limit=N]` |

> Las migraciones hacen **escrituras irreversibles** en QB y HS. Revisa las preconditions (webhooks apagados, cola de jobs vacía, backup de `entitymappings`) antes de ejecutarlas.

---

## 12. Endpoints expuestos

No es una API REST. Los únicos endpoints son:

### Webhooks

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/webhook/hubspot` | Eventos de HubSpot (firma HMAC `v3`/`v1`, ventana anti-replay de 5 min). |
| `POST` | `/webhook/quickbooks` | Eventos de QuickBooks. Acepta formato legacy (`eventNotifications`) y CloudEvents. |

### OAuth / conexión QuickBooks (prefijo `/auth`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/auth/quickbooks/connect` | API key | Genera la URL de autorización de Intuit con `state` anti-CSRF. |
| `GET` | `/auth/quickbooks/callback` | pública | Intuit redirige aquí tras autorizar; intercambia el `code` por tokens. |
| `GET` | `/auth/quickbooks/status` | API key | Estado de la conexión y expiración de tokens. |
| `POST` | `/auth/quickbooks/disconnect` | API key | Limpia los tokens de QB del tenant. |
| `GET` | `/auth/quickbooks/disconnected` | pública | Landing de confirmación cuando el cliente desconecta desde QB. |

### Páginas estáticas (requeridas por Intuit)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/privacy` | Política de privacidad. |
| `GET` | `/eula` | Términos de uso (EULA). |
| `GET` | `/` | Healthcheck básico (`{ message: "API funcionando satisfactoriamente" }`). |

Los endpoints con API key validan el header `x-api-key` contra `INTERNAL_API_KEY` (comparación timing-safe).

---

## 13. Puesta en producción

Pasos resumidos para promover un tenant a producción (detalle de cada script y validaciones en [`CLAUDE.md`](CLAUDE.md) → *Production Setup Checklist*):

1. `node src/scripts/seed-tenants.js` — bootstrap del tenant (consulta HubSpot).
2. Conectar QuickBooks por OAuth: `GET /auth/quickbooks/connect` (header `x-api-key`) → autorizar en Intuit.
3. `node src/scripts/configure-deposit-accounts.js --file=config/deposit-accounts.json` — cuentas de depósito por moneda.
4. Verificar `NODE_ENV=production` (activa la validación de firma de webhooks) y activar las suscripciones de webhooks en HubSpot e Intuit.

Pendientes y riesgos de producción: [`docs/ESTADO-DEL-PROYECTO.md`](docs/ESTADO-DEL-PROYECTO.md).

---

## 14. Documentación adicional

| Documento | Contenido |
|---|---|
| [Guía de Usuario](docs/Guia-de-Usuario-Integracion-HubSpot-QuickBooks.md) | Reglas de negocio por entidad y troubleshooting para el usuario final. |
| [Arquitectura](docs/ARQUITECTURA.md) | Diseño del sistema, flujo de datos y decisiones técnicas. |
| [Estado del proyecto](docs/ESTADO-DEL-PROYECTO.md) | Pendientes, riesgos, mejoras, incidencias y dependencias con terceros. |
| [`CLAUDE.md`](CLAUDE.md) | Referencia técnica profunda (fuente de verdad técnica). |

---

## 15. Licencia

Licencia declarada en `package.json`: **MIT**. Al tratarse de una integración privada para un cliente, conviene **confirmar** que esa es la licencia deseada y, si corresponde, agregar un archivo `LICENSE` (ver pendientes en [`docs/ESTADO-DEL-PROYECTO.md`](docs/ESTADO-DEL-PROYECTO.md)).
