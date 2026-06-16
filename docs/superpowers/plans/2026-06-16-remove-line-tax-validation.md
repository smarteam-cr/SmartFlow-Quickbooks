# Remove Line-Tax Validation (HS→QB Invoice Sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que las facturas HS→QB se sincronicen (y los pagos se concilien) sin que las líneas tengan `hs_tax_rate_group_id`, eliminando la validación de tax por línea; el impuesto lo determina el producto en QB (operativamente 0%).

**Architecture:** Se eliminan dos bloqueos en `src/services/invoice.sync.service.js` (la validación `validateLineTax` y la carga + guarda de `taxMappings`). El mapper, el cliente QB y el flujo de pagos quedan intactos. La línea de factura sigue llevando el `SalesTaxCodeRef` del producto QB (sin cambios), por lo que el impuesto aplicado en QB es idéntico al de hoy. Se actualizan docs y comentarios que quedan obsoletos.

**Tech Stack:** Node.js (CommonJS), Fastify, MongoDB/Mongoose. **No hay suite de tests ni linter** en el repo (`CLAUDE.md`: "No test suite or linter is configured"). Verificación = `node --check` (sintaxis) + verificación funcional manual.

**Estrategia de commit (instrucción del usuario):** UN solo commit, directo en `main`, al FINAL, cuando todo esté listo para probar. NO hacer commits intermedios ni crear rama. Mensaje de commit de una sola línea, sin co-autoría.

**Spec de referencia:** `docs/superpowers/specs/2026-06-16-remove-line-tax-validation-design.md`

---

## File Structure

| Archivo | Acción | Responsabilidad tras el cambio |
|---|---|---|
| `src/services/invoice.sync.service.js` | Modificar | Sync de facturas HS→QB sin validación de tax por línea ni dependencia de `taxMappings`. |
| `CLAUDE.md` | Modificar | Documentación: capa 3 de tax eliminada; `taxMappings` marcado vestigial. |
| `src/scripts/configure-tax-mappings.js` | Modificar (solo header/comentario) | Notar que `taxMappings` ya no se consume en runtime. |
| `src/db/models/tenant.model.js` | Modificar (solo comentario) | Notar que `preferences.taxMappings` quedó vestigial. |

No se crean archivos nuevos. No se tocan: `quickbooks.mapper.js`, `quickbooks.client.js`, `payment.sync.service.js`, `worker.js`.

---

## Task 1: Eliminar la función `validateLineTax` y su llamada

**Files:**
- Modify: `src/services/invoice.sync.service.js`

- [ ] **Step 1: Eliminar la llamada a `validateLineTax` dentro del loop de line items**

Edición (Edit tool). `old_string`:

```javascript
    for (const item of lineItemsData) {
      const { qbItemId, qbSalesTaxCodeId } = await resolveQbItemIdForLineItem(item, tenantId);
      validateLineTax(item, qbItemId, qbSalesTaxCodeId, taxMappings);
      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId, qbSalesTaxCodeId);
      qbInvoiceLines.push(mappedLine);
    }
```

`new_string`:

```javascript
    for (const item of lineItemsData) {
      // El impuesto de cada línea lo determina el SalesTaxCodeRef del producto en QB
      // (resuelto abajo). Ya NO se valida hs_tax_rate_group_id de HS: el cliente dejó de
      // usar ese campo. Precondición operativa: todo producto en QB debe tener tax 0%.
      const { qbItemId, qbSalesTaxCodeId } = await resolveQbItemIdForLineItem(item, tenantId);
      const mappedLine = qbMapper.mapLineItemToQb(item, qbItemId, qbSalesTaxCodeId);
      qbInvoiceLines.push(mappedLine);
    }
```

⚠️ Mantener intactas la línea del destructuring (`qbItemId, qbSalesTaxCodeId`) y la llamada a `qbMapper.mapLineItemToQb(...)`. Solo se elimina la línea `validateLineTax(...)`. Si se rompe el flujo de `qbSalesTaxCodeId` al mapper, este recibe `undefined` y falla en `.toString()`.

- [ ] **Step 2: Eliminar la definición de la función `validateLineTax` (comentario + cuerpo)**

Edición (Edit tool). `old_string`:

```javascript
/**
 * Valida que el tax seleccionado en la línea de HS coincida con el tax
 * del item en QB, usando taxMappings del tenant como tabla de traducción.
 * Lanza Error con detalle si hay discrepancia — aborta la creación de la factura.
 */
function validateLineTax(item, qbItemId, qbSalesTaxCodeId, taxMappings) {
  const hsTaxId = item.properties?.hs_tax_rate_group_id;

  if (!hsTaxId) {
    throw new Error(`Line item ${item.id} sin hs_tax_rate_group_id. El usuario debe seleccionar una tasa en HS.`);
  }

  const expectedHsTaxId = Object.keys(taxMappings).find(k => taxMappings[k] === qbSalesTaxCodeId);
  if (!expectedHsTaxId) {
    throw new Error(`QB item ${qbItemId} usa TaxCode ${qbSalesTaxCodeId} que no está en taxMappings del tenant. Ejecuta configure-tax-mappings.js para registrarlo.`);
  }

  if (hsTaxId !== expectedHsTaxId) {
    const hsMappedTo = taxMappings[hsTaxId] || '(sin mapeo)';
    throw new Error(
      `Tax mismatch en line item ${item.id}: HS envía "${hsTaxId}" (→ QB ${hsMappedTo}), pero QB item ${qbItemId} tiene TaxCode ${qbSalesTaxCodeId} (← HS esperado "${expectedHsTaxId}").`
    );
  }
}

```

`new_string`: (cadena vacía — se borra todo el bloque, incluida la línea en blanco que lo seguía)

```javascript
```

- [ ] **Step 3: Actualizar el comentario obsoleto de `resolveQbItemIdForLineItem`**

Edición (Edit tool). `old_string`:

```javascript
 * Siempre se termina con un `getItemById` para extraer SalesTaxCodeRef,
 * que se usa luego para la validación estricta de tax.
 */
```

`new_string`:

```javascript
 * Siempre se termina con un `getItemById` para extraer SalesTaxCodeRef,
 * que se usa como TaxCodeRef de la línea en QB (la línea hereda el tax del producto).
 */
```

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check src/services/invoice.sync.service.js`
Expected: sin salida y exit code 0 (sintaxis válida).

---

## Task 2: Eliminar la carga de `taxMappings` y su guarda

**Files:**
- Modify: `src/services/invoice.sync.service.js`

- [ ] **Step 1: Eliminar el bloque de carga de `taxMappings` + el throw por config vacía**

Edición (Edit tool). `old_string`:

```javascript
    // 4. Cargar tenant (para utcOffset + taxMappings)
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) throw new Error(`Tenant ${tenantId} no encontrado.`);

    const taxMappings = {};
    const rawTaxMappings = tenant.preferences?.taxMappings;
    if (rawTaxMappings instanceof Map) {
      for (const [k, v] of rawTaxMappings.entries()) taxMappings[k] = v;
    } else if (rawTaxMappings && typeof rawTaxMappings === 'object') {
      Object.assign(taxMappings, rawTaxMappings);
    }
    if (Object.keys(taxMappings).length === 0) {
      throw new Error(`Tenant ${tenantId} sin taxMappings configurados. Ejecuta configure-tax-mappings.js antes de sincronizar facturas.`);
    }

    const utcOffsetMs = tenant?.hubspot?.utcOffsetMilliseconds || 0;
```

`new_string`:

```javascript
    // 4. Cargar tenant (para utcOffset). taxMappings ya NO se usa: la validación de tax
    // por línea fue eliminada y el tax lo determina el producto en QB.
    const tenant = await Tenant.findOne({ tenantId });
    if (!tenant) throw new Error(`Tenant ${tenantId} no encontrado.`);

    const utcOffsetMs = tenant?.hubspot?.utcOffsetMilliseconds || 0;
```

⚠️ Mantener `Tenant.findOne(...)` y `if (!tenant) throw ...`: `utcOffsetMs` sigue dependiendo del tenant.

- [ ] **Step 2: Actualizar el comentario de sección obsoleto**

Edición (Edit tool). `old_string`:

```javascript
    // 5. Resolución de PRODUCTOS + validación estricta de tax por línea
```

`new_string`:

```javascript
    // 5. Resolución de PRODUCTOS (el tax de cada línea se hereda del producto en QB)
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check src/services/invoice.sync.service.js`
Expected: sin salida y exit code 0.

- [ ] **Step 4: Confirmar que no quedan referencias colgantes a `validateLineTax` ni `taxMappings` en el archivo**

Run: `grep -n "validateLineTax\|taxMappings" src/services/invoice.sync.service.js`
Expected: sin resultados (exit code 1). Si aparece algo, hay una referencia colgante que rompería el runtime.

---

## Task 3: Actualizar documentación y comentarios vestigiales

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/scripts/configure-tax-mappings.js`
- Modify: `src/db/models/tenant.model.js`

- [ ] **Step 1: Leer `CLAUDE.md` para localizar las secciones a editar**

Run: (usar Read tool sobre `CLAUDE.md`) y localizar:
- La lista "**Three-layer currency validation**" en la sección de Invoices.
- En `configure-tax-mappings.js` (sección Scripts): "**Required before invoices can sync** — invoice sync throws if not configured."
- En Multi-Tenancy: "`preferences.taxMappings` (HS taxRateGroupId → QB TaxCode ID) — required by invoice sync".

- [ ] **Step 2: Reemplazar la validación de "tres capas" por "dos capas" en `CLAUDE.md`**

Edición (Edit tool). `old_string`:

```markdown
- **Three-layer currency validation** (fail-fast, no QB call if any layer fails):
  1. **HS-vs-HS** (cheap, no APIs): `hsInvoice.hs_currency` must equal `contactInfo.preferredCurrency`.
  2. **HS-vs-QB**: `hsInvoice.hs_currency` must equal `qbCustomer.CurrencyRef.value` (in case a drift fix hadn't run yet).
  3. **Per-line tax compatibility**: each line item's `hs_tax_rate_group_id` must map (via `tenant.preferences.taxMappings`) to the QB TaxCode that the QB item already has.
  All three throw `CurrencyMismatchError` (or a tax-specific message) with actionable text so the user knows how to fix the data. Job marked SKIPPED.
```

`new_string`:

```markdown
- **Two-layer currency validation** (fail-fast, no QB call if any layer fails):
  1. **HS-vs-HS** (cheap, no APIs): `hsInvoice.hs_currency` must equal `contactInfo.preferredCurrency`.
  2. **HS-vs-QB**: `hsInvoice.hs_currency` must equal `qbCustomer.CurrencyRef.value` (in case a drift fix hadn't run yet).
  Both throw `CurrencyMismatchError` with actionable text so the user knows how to fix the data. Job marked SKIPPED.
- **Per-line tax**: each invoice line inherits the QB product's `SalesTaxCodeRef` as its `TaxCodeRef` (via `mapLineItemToQb`), and the document uses `GlobalTaxCalculation=TaxExcluded`, so QB adds tax on top per that code. The HS line property `hs_tax_rate_group_id` is **no longer validated nor used** — the former `validateLineTax` check was removed. **Operational precondition:** every QB product must use a 0% sales tax code so QB adds nothing and HS/QB totals match. There is no code enforcement of the 0% rate; the only surviving guard requires the QB item to have *some* `SalesTaxCodeRef`.
```

- [ ] **Step 3: Suavizar el requisito de `configure-tax-mappings.js` en `CLAUDE.md`**

Edición (Edit tool). `old_string`:

```markdown
Configures `tenant.preferences.taxMappings` (HS `hs_tax_rate_group_id` → QB `TaxCode.Id`). **Required before invoices can sync** — invoice sync throws if not configured. Shows diff of current vs. desired state and prompts for confirmation before applying.
```

`new_string`:

```markdown
Configures `tenant.preferences.taxMappings` (HS `hs_tax_rate_group_id` → QB `TaxCode.Id`). **Vestigial:** as of 2026-06-16 invoice sync no longer reads `taxMappings` (the per-line tax validation was removed). This script and the field are kept but no longer affect invoice tax behavior. Shows diff of current vs. desired state and prompts for confirmation before applying.
```

- [ ] **Step 4: Marcar `preferences.taxMappings` como vestigial en la sección Multi-Tenancy de `CLAUDE.md`**

Edición (Edit tool). `old_string`:

```markdown
- `preferences.taxMappings` (HS taxRateGroupId → QB TaxCode ID) — required by invoice sync
```

`new_string`:

```markdown
- `preferences.taxMappings` (HS taxRateGroupId → QB TaxCode ID) — **vestigial** (no longer read by invoice sync as of 2026-06-16)
```

- [ ] **Step 5: Anotar el comentario en `tenant.model.js`**

Leer `src/db/models/tenant.model.js` alrededor de la línea 27. Edición (Edit tool). `old_string`:

```javascript
    // Mapeo entre internal values del dropdown de tax en HS (hs_tax_rate_group_id)
```

`new_string`:

```javascript
    // VESTIGIAL (2026-06-16): ya no se consume en runtime — invoice sync dejó de validar tax por línea.
    // Se conserva el campo por compatibilidad. Mapeo internal values del dropdown de tax en HS (hs_tax_rate_group_id)
```

- [ ] **Step 6: Anotar el header de `configure-tax-mappings.js`**

Leer `src/scripts/configure-tax-mappings.js` (primeras ~15 líneas) para ubicar el comentario de cabecera del archivo. Añadir, en la primera línea de comentario del archivo, una nota de vestigialidad. Edición (Edit tool): insertar al inicio del bloque de comentario superior la línea:

```javascript
// NOTA (2026-06-16): VESTIGIAL — invoice sync ya no lee taxMappings. Este script se conserva
// pero no afecta el cálculo de tax de las facturas.
```

(Colócala como primera línea del archivo, antes del comentario/`require` existente.)

- [ ] **Step 7: Verificar sintaxis de los archivos JS tocados**

Run: `node --check src/db/models/tenant.model.js && node --check src/scripts/configure-tax-mappings.js`
Expected: sin salida y exit code 0.

---

## Task 4: Verificación funcional manual (antes del commit)

**Files:** ninguno (verificación).

- [ ] **Step 1: Verificación de sintaxis global de los archivos modificados**

Run:
```bash
node --check src/services/invoice.sync.service.js && \
node --check src/db/models/tenant.model.js && \
node --check src/scripts/configure-tax-mappings.js && \
echo "SYNTAX OK"
```
Expected: imprime `SYNTAX OK`.

- [ ] **Step 2: Confirmar que `taxMappings`/`validateLineTax` solo quedan en lugares vestigiales esperados**

Run: `grep -rn "validateLineTax\|taxMappings" src/`
Expected: cero hits de `validateLineTax`. Hits de `taxMappings` SOLO en: `src/scripts/configure-tax-mappings.js`, `src/db/models/tenant.model.js`, `src/scripts/seed-tenants.js`. NINGÚN hit en `src/services/invoice.sync.service.js`.

- [ ] **Step 3: Prueba funcional en entorno de pruebas (manual)**

Sigue el plan de verificación del spec (§8):
1. Factura en HS con line item(s) **sin** `hs_tax_rate_group_id`; producto mapeado a item QB con código de tax **0%**; contacto/moneda válidos; `hs_balance_due=0` y `hs_amount_billed>0`.
2. Confirmar que la factura **se crea en QB** (antes abortaba con error de tax/taxMappings).
3. Confirmar en logs `TotalAmt` de QB == `hs_amount_billed` (coinciden por el 0%). Revisar el log diagnóstico `🔎 [Invoice] ... taxCodeIds=[...]` (`invoice.sync.service.js:228-235`) y verificar que los códigos sean los 0% esperados.
4. Registrar un pago a esa factura en HS y confirmar que se **aplica/enlaza** en QB (`reconcilePaymentsForInvoice`). Requiere que el pago HS tenga `hs_reference_number` y que `syncPaymentToQuickbooks` haya creado el pago en QB con `PaymentRefNum` coincidente.

Expected: factura creada en QB con total igual al de HS, y pago aplicado.

---

## Task 5: Commit único en `main`

**Files:** ninguno (commit).

- [ ] **Step 1: Revisar el diff completo**

Run: `git status && git diff --stat`
Expected: modificados `src/services/invoice.sync.service.js`, `CLAUDE.md`, `src/scripts/configure-tax-mappings.js`, `src/db/models/tenant.model.js` (+ los archivos de `docs/superpowers/` de spec y plan, si se decide incluirlos).

- [ ] **Step 2: Commit único, una sola línea, sin co-autoría, en `main`**

Run:
```bash
git add -A
git commit -m "feat: stop validating per-line tax (hs_tax_rate_group_id) in HS->QB invoice sync; QB product tax code drives line tax"
```
Expected: un solo commit creado en `main`. NO crear rama. NO co-autoría. NO `git push` salvo que el usuario lo pida.

---

## Self-Review (completado por el autor del plan)

**1. Cobertura del spec:**
- §4.1 (quitar `validateLineTax` call) → Task 1 Step 1. ✓
- §4.1 (borrar función) → Task 1 Step 2. ✓
- §4.2 (quitar `taxMappings` load + throw, conservar `Tenant.findOne`) → Task 2 Step 1. ✓
- §4.3 (no romper `qbSalesTaxCodeId` al mapper) → Task 1 Step 1 (advertencia explícita). ✓
- §4.4 (mantener guarda `SalesTaxCodeRef`) → no se toca (no aparece en ninguna edición). ✓
- §4.5 / §9 (comentarios stale `:31-32`, `:199`) → Task 1 Step 3, Task 2 Step 2. ✓
- §5 (vestigial dejado y documentado) → Task 3 Steps 3-6. ✓
- §6 (supuesto 0% documentado) → Task 3 Step 2 (CLAUDE.md) + comentario en Task 1 Step 1. ✓
- §8 (verificación) → Task 4. ✓
- §9 (CLAUDE.md tres→dos capas, vestigial) → Task 3 Steps 2-4. ✓
- Estrategia de commit único en main → Task 5. ✓

**2. Placeholder scan:** sin TBD/TODO; todas las ediciones muestran `old_string`/`new_string` concretos. ✓

**3. Type/símbolo consistency:** no se introducen funciones/tipos nuevos; `qbSalesTaxCodeId`, `qbItemId`, `mapLineItemToQb`, `utcOffsetMs`, `Tenant.findOne` se usan con los mismos nombres del código existente. ✓
