# Diseño: Eliminar la validación de tasa impositiva por línea en el sync de facturas HS→QB

- **Fecha:** 2026-06-16
- **Estado:** Aprobado (diseño) — pendiente de plan de implementación
- **Archivo principal afectado:** `src/services/invoice.sync.service.js`

## 1. Contexto y problema

El cliente dejará de usar el campo de tasa impositiva en HubSpot (`hs_tax_rate_group_id`,
presente en los line items de una factura). Hoy, el sync de facturas HS→QB **aborta** la
creación de la factura si ese campo falta o no es coherente con el impuesto del producto en QB.

Como `reconcilePaymentsForInvoice` solo corre **al final de una creación exitosa de factura
HS→QB** (`invoice.sync.service.js:268`), si la factura aborta, el pago nunca se enlaza/aplica
en QB. Por eso, al registrar un pago a una factura cuyas líneas no tienen tasa, el pago no se
refleja en QuickBooks.

Flujo de producción confirmado con el cliente: **las facturas se crean en HubSpot y se
sincronizan a QB (HS→QB).** Este cambio aplica a ese flujo.

## 2. Hallazgo clave

El valor de impuesto que termina en la factura de QB **no** proviene de HubSpot: la línea
siempre lleva el `SalesTaxCodeRef` del **producto en QB** (`quickbooks.mapper.js:25`), y el
documento usa `GlobalTaxCalculation: "TaxExcluded"` (`quickbooks.mapper.js:34`), por lo que QB
**suma el impuesto encima** de los montos de línea según ese código.

`validateLineTax` nunca construyó ese valor: solo **abortaba** cuando la tasa seleccionada en
HS no era coherente con el código del producto en QB. Por lo tanto, eliminar la validación
**no cambia el impuesto que QB aplica** — solo deja de abortar.

## 3. Decisión / objetivo

Permitir que las facturas HS→QB se sincronicen (y por ende los pagos se concilien) **sin que
las líneas tengan `hs_tax_rate_group_id`**. El impuesto de cada línea se hereda del producto
en QB, que operativamente será un **código de 0%**, de modo que QB no agregue nada y los
totales coincidan entre ambas plataformas.

## 4. Alcance del cambio (qué se edita)

Todo en `src/services/invoice.sync.service.js`:

1. **Eliminar la llamada a `validateLineTax`** dentro del loop de line items (`:206`) y
   **borrar la función** `validateLineTax` (`:82-100`, con su comentario `:77-81`).
2. **Eliminar la carga de `taxMappings` y el `throw` por config vacía** (`:186-195`).
   **Mantener** `Tenant.findOne(...)` (`:183`) porque `utcOffsetMs` (`:197`) sigue
   dependiendo de él. Solo se quita el uso de `taxMappings`.
3. **No tocar** el destructuring de `qbSalesTaxCodeId` (`:205`) ni su paso a
   `qbMapper.mapLineItemToQb(...)` (`:207`). `qbSalesTaxCodeId` debe seguir fluyendo al
   mapper; si se rompe ese hilo, el mapper recibe `undefined` y falla en `.toString()`
   (`quickbooks.mapper.js:25`).
4. **Mantener intacta** la guarda de `resolveQbItemIdForLineItem` que lanza si el producto QB
   no tiene `SalesTaxCodeRef` (`:70-72`) — decisión del cliente (bloqueo B se queda).
5. **Actualizar comentarios** stale: `:31-32` ("…validación estricta de tax") y `:199`
   ("+ validación estricta de tax por línea").

## 5. Qué NO cambia / fuera de alcance

- **Mapper** (`quickbooks.mapper.js`): sin cambios. `TaxExcluded` y `TaxCodeRef` por línea
  se mantienen.
- **Sync de pagos** (`payment.sync.service.js`): estructuralmente independiente del tax;
  no se toca.
- **QB→HS** (`handleInvoiceEmailed`) y **sync de productos** (`impuesto_sobre_las_ventas`):
  sin cambios.
- **Código vestigial** (decisión tomada): `src/scripts/configure-tax-mappings.js`, el campo
  `preferences.taxMappings` en `tenant.model.js:29` y su default en `seed-tenants.js:51` se
  **dejan en su lugar** y solo se documentan como ya-no-usados. Es seguro: el campo es
  opcional (no `required`, sin default), nadie lo lee en runtime tras el cambio.
- **Facturas nativas de QB**: la conciliación de pagos no corre para facturas creadas
  directamente en QB (hueco pre-existente, `reconcilePaymentsForInvoice` solo se invoca en el
  camino HS→QB). Este cambio **no** cubre ese caso; queda como tema aparte.
- **Red de seguridad contra divergencia de totales**: NO se implementa (decisión del cliente:
  solo documentar el supuesto). Sin comparación post-creación de totales ni validación de 0%.

## 6. Supuesto operativo crítico (debe quedar muy visible)

Tras el cambio, **nada en el código verifica que el código de tax del producto en QB sea 0%.**
La única guarda viva (`:70-72`) solo comprueba que *exista* un `SalesTaxCodeRef`, no su tasa.

**Precondición de producción obligatoria:** todo producto/servicio en QuickBooks debe usar un
código de impuesto de **0%**. Si un solo producto queda con una tasa ≠ 0%:

- QB sumará ese impuesto encima de los montos de línea (`TaxExcluded`), produciendo un
  `TotalAmt` **mayor** que `hs_amount_billed`, **sin error y sin SKIP**.
- El pago enlazará el monto cobrado en HS (menor que el total inflado de QB), dejando la
  factura QB **parcialmente pagada** con saldo residual.

Antes esta inconsistencia se bloqueaba duro: `validateLineTax` lanza un `Error` plano →
worker la marca **FAILED → reintenta → DEAD_LETTER** (no SKIPPED). El cambio reemplaza ese
bloqueo por una suposición operativa no verificada en código.

## 7. Riesgos y su manejo

| Riesgo | Severidad | Nuevo vs hoy | Manejo |
|---|---|---|---|
| Divergencia silenciosa de totales si un producto QB tiene tasa ≠ 0% | Alto | Nuevo | Documentar la precondición 0% (este doc + CLAUDE.md). Sin red de seguridad por decisión del cliente. |
| Facturas sin `hs_tax_rate_group_id` ahora sí sincronizan | Bajo | Nuevo | Es el objetivo. |
| Tenant sin `taxMappings` ya no bloquea el sync | Bajo | Nuevo | `taxMappings` queda vestigial; documentar. |
| `hs_tax_rate_group_id` se ignora aunque se llene en HS | Bajo | Nuevo | Documentar que ya no es autoritativo. |
| Remoción global, no por-tenant | Bajo | Nuevo | Hoy corre con un tenant; documentar el supuesto single-tenant. |
| Producto QB sin `SalesTaxCodeRef` → FAILED/retry/DEAD_LETTER (no SKIP) | Bajo | Pre-existente | Sin cambio. Opcional futuro: convertir a `SkipJobError`. Fuera de alcance. |
| Deriva de docs (CLAUDE.md "tres capas", capa 3; "configure-tax-mappings requerido") | Bajo | — | Actualizar docs (ver §9). |

## 8. Plan de verificación

No hay suite de tests ni linter en el repo → verificación manual:

1. Factura en HS con line item(s) **sin** `hs_tax_rate_group_id`, producto mapeado a un item
   QB con código de tax **0%**, contacto/moneda válidos, `hs_balance_due=0` y
   `hs_amount_billed>0`.
2. Confirmar que la factura **se crea en QB** (antes abortaba).
3. Confirmar que `TotalAmt` de QB == `hs_amount_billed` de HS (coinciden por el 0%).
4. Registrar un pago a esa factura en HS y confirmar que **se aplica/enlaza** en QB vía
   `reconcilePaymentsForInvoice` (requiere que el pago HS tenga `hs_reference_number` y haya
   sincronizado a QB con `PaymentRefNum` coincidente).
5. Revisar el log diagnóstico (`invoice.sync.service.js:228-235`) para ver los `taxCodeIds`
   aplicados y detectar visualmente cualquier código ≠ 0%.

## 9. Documentación a actualizar

- **CLAUDE.md**: cambiar "Three-layer currency validation" → dos capas (eliminar la capa 3 de
  compatibilidad de tax por línea); aclarar que el tax de la línea lo determina únicamente el
  `SalesTaxCodeRef` del producto QB con `GlobalTaxCalculation=TaxExcluded`; marcar
  `taxMappings` / `configure-tax-mappings.js` como vestigial (ya no requerido para el sync de
  facturas); suavizar "required before invoices can sync".
- **Comentarios en `invoice.sync.service.js`** (`:31-32`, `:199`).
- **Header de `configure-tax-mappings.js`** y comentario en `tenant.model.js:27-28`: notar que
  `taxMappings` ya no se consume en runtime.

## 10. Dificultad estimada

**Baja.** ~3 ediciones en un solo archivo + actualización de docs/comentarios. Sin cambios al
mapper, cliente QB ni flujo de pagos. El esfuerzo real está en la disciplina operativa
(garantizar 0% en todos los productos QB), no en el código.
