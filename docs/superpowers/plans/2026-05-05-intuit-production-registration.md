# Intuit Production App Registration Plan

> **Nota:** Este es un plan de configuración/setup, no de implementación de código. Las tareas de código son mínimas y puntuales. El objetivo es dejar todo listo para que el cliente cree la app en el portal de Intuit sin que Intuit la rechace.

**Goal:** Tener todo listo — URLs, páginas, variables de entorno y código — para que el cliente registre la app privada en Intuit Developer Portal y obtenga el Client ID + Secret de producción sin que el assessment lo rechace.

**Contexto:**
- App privada de un solo cliente (no se publica en Marketplace)
- OAuth 2.0 ya implementado en el servidor (`/auth/quickbooks/callback`, `/auth/quickbooks/connect`)
- El desarrollador maneja el flujo OAuth directamente (con Postman o internamente) — el cliente no inicia el OAuth desde QB
- Deadline crítico: migración webhooks CloudEvents → **31 julio 2026**

**Tech Stack:** Node.js + Fastify, MongoDB, desplegado con nginx + HTTPS

---

## Mapa de lo que falta

| Item | Estado | Bloqueante para Intuit? |
|---|---|---|
| Redirect URI | ✅ Implementado (`/auth/quickbooks/callback`) | Solo falta apuntar al dominio prod |
| Disconnect URL | ❌ No existe página de destino pública | ✅ Sí — el formulario la exige |
| Reconnect URL | ❌ No existe | ✅ Sí — obligatorio desde feb 2026 |
| Privacy Policy URL | ❌ No existe | ✅ Sí — bloquea el formulario |
| EULA URL | ❌ No existe | ✅ Sí — bloquea el formulario |
| `intuit_tid` en logs | ❌ No capturado | ⚠️ Pregunta del assessment (respuesta honesta: NO) |
| Webhooks CloudEvents | ❌ Formato viejo (`eventNotifications`) | ⚠️ Assessment pregunta si usas webhooks; post-prod deadline jul 2026 |
| Variable `QB_SANDBOX_BASE_URL` → URL prod | ❌ Apunta a sandbox | ✅ Sí — para que el sistema funcione en prod |

---

## Parte 1 — Cambios mínimos en el servidor (bloqueantes para el formulario)

### Tarea 1: Crear 3 páginas/endpoints estáticos

Estos 3 endpoints solo necesitan responder 200 con HTML simple. **No tienen lógica.**

**Archivos a modificar:**
- `src/routes/auth.routes.js` — agregar las 3 rutas nuevas
- Crear: `src/public/privacy.html`
- Crear: `src/public/eula.html`
- Crear: `src/public/disconnected.html`

**Rutas a agregar:**

```
GET /auth/quickbooks/disconnected   → página estática HTML "Desconectado de QuickBooks"
GET /privacy                        → política de privacidad básica
GET /eula                           → términos de uso básicos
```

Las 3 rutas deben ser **públicas** (sin API key) porque:
- El formulario de Intuit valida que respondan 200 (posiblemente con un HTTP HEAD/GET automático)
- `/auth/quickbooks/disconnected`: es donde el navegador del cliente aterriza si hace disconnect desde su portal de QB
- `/privacy` y `/eula`: son URLs que Intuit muestra públicamente en el perfil de la app

**Contenido mínimo de `/auth/quickbooks/disconnected`:**
```html
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Desconectado</title></head>
<body>
  <h1>QuickBooks desconectado</h1>
  <p>Tu empresa de QuickBooks ha sido desconectada de la integración.</p>
  <p>Si fue un error, contacta al administrador del sistema para reconectar.</p>
</body>
</html>
```

**Contenido mínimo de `/privacy`:**
```html
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Política de Privacidad</title></head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Aplicación:</strong> SmartFlow QuickBooks Integration</p>
  <p><strong>Uso:</strong> Esta aplicación es de uso interno y privado. Accede a datos de QuickBooks Online
     únicamente para sincronizar información contable con HubSpot CRM.</p>
  <p><strong>Datos:</strong> No se comparten datos con terceros. Los datos se almacenan en servidores
     privados y se usan exclusivamente para la integración autorizada por el usuario.</p>
  <p><strong>Contacto:</strong> [EMAIL DEL CLIENTE]</p>
  <p><strong>Última actualización:</strong> Mayo 2026</p>
</body>
</html>
```

**Contenido mínimo de `/eula`:**
```html
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Términos de Uso</title></head>
<body>
  <h1>Términos de Uso (EULA)</h1>
  <p><strong>Aplicación:</strong> SmartFlow QuickBooks Integration</p>
  <p>Esta integración es de uso exclusivo interno. Al autorizar el acceso a QuickBooks Online,
     aceptas que la aplicación accederá a tus datos de contabilidad para sincronizarlos con
     HubSpot CRM de forma automatizada.</p>
  <p>El acceso puede revocarse en cualquier momento desde el portal de QuickBooks Online
     en Aplicaciones → Mis Aplicaciones → Desconectar.</p>
  <p><strong>Contacto:</strong> [EMAIL DEL CLIENTE]</p>
</body>
</html>
```

**Reconnect URL:** usa la misma URL que `/auth/quickbooks/connect`. En el formulario de Intuit pondrás la misma URL en ambos campos (Connect y Reconnect). Si el cliente hace clic en el enlace de reconexión de una notificación de Intuit y `/connect` tiene API key, verá 401 — pero como es un solo cliente y el developer maneja el OAuth, eso es aceptable. Si quieres evitarlo, crea una versión pública de `/connect` sin API key protegida solo por el state CSRF (ya implementado).

---

### Tarea 2: Capturar `intuit_tid` en logs de error de QB

**Archivo:** `src/utils/axios.error.util.js`

El App Assessment pregunta en la sección "Error Handling": *"Does your app capture the value of the `intuit_tid` field from response headers?"*

Actualmente la respuesta es NO. Agrega la captura en el interceptor o en `extractAxiosError`:

```js
// En el interceptor 401 de quickbooks.client.js o en extractAxiosError:
const intuitTid = error?.response?.headers?.['intuit_tid'] || 
                  error?.response?.headers?.['intuit-tid'] || 
                  'N/A';
logger.error('[QB Error]', { intuitTid, ...otherInfo });
```

Esto no es bloqueante para obtener las keys, pero el assessment te pregunta y es mejor contestar SÍ honestamente.

---

### Tarea 3: Variables de entorno para producción

Cuando el cliente te pase el Client ID y Secret de producción, debes cambiar estas variables:

| Variable | Valor sandbox | Valor producción |
|---|---|---|
| `QB_CLIENT_ID` | ID de sandbox | ID de producción (lo da el cliente) |
| `QB_CLIENT_SECRET` | Secret de sandbox | Secret de producción (lo da el cliente) |
| `QB_SANDBOX_BASE_URL` | `https://sandbox-quickbooks.api.intuit.com` | `https://quickbooks.api.intuit.com` |
| `QB_REDIRECT_URI` | URL local/sandbox | `https://TU_DOMINIO/auth/quickbooks/callback` |

**Importante:** Renombra `QB_SANDBOX_BASE_URL` a `QB_BASE_URL` para mayor claridad, o simplemente actualiza el valor sin renombrar (más simple, sin tocar código).

---

## Parte 2 — Tabla de URLs para entregarle al cliente

Una vez que tengas dominio HTTPS de producción, dale al cliente exactamente esta tabla:

| Campo en Intuit | Valor |
|---|---|
| **Redirect URI** | `https://TU_DOMINIO/auth/quickbooks/callback` |
| **Host Domain** | `TU_DOMINIO` (ej: `smartflow.tuempresa.com`) |
| **Launch URL** | `https://TU_DOMINIO/auth/quickbooks/connect` |
| **Disconnect URL** | `https://TU_DOMINIO/auth/quickbooks/disconnected` |
| **Connect/Reconnect URL** | `https://TU_DOMINIO/auth/quickbooks/connect` |
| **Privacy Policy URL** | `https://TU_DOMINIO/privacy` |
| **EULA URL** | `https://TU_DOMINIO/eula` |
| **Scope** | `com.intuit.quickbooks.accounting` |
| **App Category** | `Data Management` (o `Invoicing`) |
| **Regulated Industries** | Ninguna (a menos que el cliente sea banco, salud, etc.) |
| **App Hosting Region** | La región donde está tu servidor |

---

## Parte 3 — Pasos que hace el cliente en Intuit (guía para darle al cliente)

### Paso 1: Crear cuenta de developer
1. Ir a [developer.intuit.com](https://developer.intuit.com)
2. Sign up (con email de la empresa del cliente)
3. Verificar email

### Paso 2: Crear Workspace
1. My Hub → Workspaces → Create workspace
2. Llenar: nombre de empresa, datos de contacto (nombre, apellido, email, teléfono, dirección)

### Paso 3: Crear la App
1. Dentro del workspace → Create an app
2. Seleccionar **QuickBooks Online and Payments** → elegir **Accounting** (scope: `com.intuit.quickbooks.accounting`)
3. Nombre de la app (ej: "SmartFlow Integration")

### Paso 4: Configurar Production Keys & Credentials
1. Ir a la app → **Keys & OAuth** → tab **Production**
2. Llenar todos los campos con los valores de la tabla de la Parte 2
3. Asegurarse de que la Redirect URI esté en la lista (es el único campo con validación estricta — debe coincidir exactamente con lo que el servidor envía en el OAuth)

### Paso 5: Completar el App Assessment Questionnaire (~25-30 min)
El cliente completa el formulario. Usa estas respuestas como guía:

**App Details:**
- EULA y Privacy Policy: pegar las URLs de tu servidor
- Host domain, Launch, Disconnect, Reconnect: tabla de Parte 2
- Category: Data Management
- Regulated industries: Ninguna
- Hosting region: la del servidor

**App Information:**
- "Are you building a private app?" → **Yes, private/internal**
- "Which types of QB users can use your app?" → Admin
- "Does your app integrate with other platforms?" → Yes (HubSpot)

**Authorization & Authentication:**
- "Tested connect/disconnect/reconnect with sandbox?" → **Yes** (haberlo testeado antes con Postman en sandbox)
- "How often refresh tokens?" → When expired (on 401)
- "Retry failed auth requests?" → Yes
- "Ask customers to reconnect on auth error?" → Yes
- "Used Intuit discovery document?" → Yes (`https://developer.api.intuit.com/.well-known/openid_configuration`)
- "Can handle expired tokens, invalid grant, CSRF?" → Yes
- "Rely on OAuth playground?" → **No**

**API Usage:**
- "Which API categories?" → Accounting
- "How often calls per customer?" → On-demand (event-driven via webhooks)

**Accounting API:**
- "QB Online version?" → Simple Start, Essentials, Plus, Advanced
- "Handle version feature changes?" → Yes
- "Multi-currency?" → Yes
- "Sales tax variations?" → Yes
- "Use webhooks?" → **Yes**
- "Use CDC?" → **No**

**Error Handling:**
- "Tested API error handling?" → Yes
- "Capture `intuit_tid`?" → **Yes** (una vez implementada la Tarea 2)
- "Store error logs?" → Yes
- "Customer support contact?" → Yes (el cliente tiene contacto contigo)

**Security:**
- "Security breach?" → No
- "Security team?" → Respuesta honesta del cliente
- "Client ID/Secret stored securely?" → **Yes** (no hardcodeados, en .env encriptados en servidor)
- "MFA?" → Respuesta honesta
- "Captcha?" → No
- "WebSocket?" → No
- "Data shared with third parties?" → **No** (solo HubSpot del mismo cliente)

### Paso 6: Activar Production y obtener keys
1. Después de completar el assessment, Intuit lo revisa (puede tardar días o semanas)
2. Si aprueba → el cliente va a Keys & OAuth → Production → copia **Client ID** y **Client Secret**
3. El cliente te los pasa de forma segura (no por Slack/chat en texto plano)

---

## Parte 4 — Post-aprobación: migración CloudEvents (deadline: 31 julio 2026)

**Este cambio no bloquea la aprobación del assessment, pero sí bloquea el funcionamiento de la integración después de julio 2026.**

El problema: el webhook controller actual parsea el formato viejo de QB:
```js
// Formato VIEJO (actual en webhook.controller.js:24):
if (payload.eventNotifications) {
  for (const notification of payload.eventNotifications) {
    // notification.dataChangeEvent.entities
  }
}
```

El nuevo formato CloudEvents es un array plano con campos estándar (`specversion`, `id`, `source`, `type`, `intuitentityid`, `intuitaccountid`).

**Acción requerida antes del 31 julio 2026:** actualizar `webhook.controller.js` para parsear ambos formatos (el switch en el portal de QB permite testar el nuevo formato en sandbox antes de activarlo en producción).

**Magnitud:** pequeño cambio localizado en `handleQuickBooksWebhook` en [webhook.controller.js](src/controllers/webhook.controller.js). No afecta el resto del sistema.

---

## Resumen ejecutivo — Orden de ejecución

```
ANTES de darle las URLs al cliente:
  [ ] Tener dominio HTTPS de producción configurado en nginx
  [ ] Desplegar Tarea 1 (3 páginas: /disconnected, /privacy, /eula)
  [ ] Verificar que las 3 páginas respondan 200 en producción
  [ ] Agregar captura de intuit_tid (Tarea 2) — recomendado antes del assessment

El cliente hace en Intuit:
  [ ] Crear cuenta developer.intuit.com
  [ ] Crear workspace + app (QuickBooks Online Accounting)
  [ ] Llenar Keys & Credentials con la tabla de Parte 2
  [ ] Completar App Assessment Questionnaire (guía Parte 3)
  [ ] Esperar aprobación de Intuit (días/semanas)
  [ ] Pasarte Client ID + Secret de producción de forma segura

Tú configuras en el servidor:
  [ ] Actualizar variables de entorno (Tarea 3)
  [ ] Ejecutar OAuth inicial con Postman usando credenciales de producción
  [ ] Verificar que la integración funcione con datos reales de QB prod

Antes del 31 julio 2026:
  [ ] Migrar webhook controller a formato CloudEvents
  [ ] Probar con el switch de sandbox en el portal de QB
  [ ] Activar en producción
```
