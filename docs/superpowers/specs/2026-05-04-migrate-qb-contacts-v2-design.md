# Diseño: Migración QB → HS de Contactos Legacy v2

**Fecha:** 2026-05-04  
**Archivo objetivo:** `src/scripts/migrate-qb-contacts.js`  
**Tipo de cambio:** Modificación de condiciones de elegibilidad, campo de identidad y reporte

---

## Problema

El script de migración actual usa `email.slice(0, 16)` como campo de identidad (`Suffix` en QB / `documento_de_identidad` en HS). Esto es incorrecto para el cohort legacy real: la identidad de estos contactos ya existe en el campo `Notes` de QB, que contiene un identificador numérico cargado manualmente. El script debe usar ese valor directamente.

Adicionalmente, las condiciones de unicidad de email son demasiado laxas: actualmente solo detectan colisiones dentro del cohort elegible, cuando deberían verificarse contra todos los customers activos de QB.

---

## Condiciones de Elegibilidad (nuevas)

Un QB customer es elegible para migración si cumple **todas** las siguientes condiciones:

### Condición 1 — Estructura legacy (sin cambios)
- `CompanyName` tiene contenido (no vacío, no solo espacios)
- `GivenName` está vacío o ausente
- `FamilyName` está vacío o ausente

### Condición 2 — Email único en QB
- El customer tiene email (`PrimaryEmailAddr.Address`) no vacío
- Ese email **no aparece en ningún otro customer activo** de QB (elegible o no)
- Unicidad evaluada después de `trim().toLowerCase()`

### Condición 3 — Notes válido y único en QB
- `Notes` no está vacío (después de `trim()`)
- El primer carácter de `Notes.trim()` es un dígito (0–9)
- `Notes.trim()` tiene como máximo 16 caracteres
- Ese valor de `Notes.trim()` **no aparece en ningún otro customer activo** de QB

---

## Estrategia de Pre-cómputo

Al cargar todos los QB customers activos (paso que ya existe), se construyen en esa misma iteración:

1. `emailCount: Map<string, number>` — frecuencia de cada email normalizado entre todos los customers activos
2. `notesCount: Map<string, number>` — frecuencia de cada `Notes.trim()` no vacío entre todos los customers activos

Cualquier valor con conteo > 1 es una colisión. Los checks por customer son O(1) contra estos mapas.

---

## Cambios en el Proceso de Migración

### Campo de identidad
| Antes | Después |
|---|---|
| `suffix = email.slice(0, 16)` | `suffix = customer.Notes.trim()` |
| `documento_de_identidad` en HS ← `email[:16]` | `documento_de_identidad` en HS ← `Notes.trim()` |

### QB update (sin cambios estructurales, solo cambia el valor de `suffix`)
- `GivenName` ← `CompanyName` (igual que antes)
- `FamilyName` ← `''` (igual que antes)
- `CompanyName` ← `''` (igual que antes)
- `Suffix` ← `Notes.trim()` (**nuevo**: antes era `email[:16]`)
- `DisplayName` ← `"${CompanyName} ${Notes.trim()}".trim()`
- `Notes` — **no se modifica** (se preserva intacto)

### HS update (cuando el contacto ya existe en HS)
Igual que antes, excepto:
- `documento_de_identidad` ← `Notes.trim()` (antes: `email[:16]`)

### HS create (cuando no existe contacto con ese email en HS)
Igual que antes, excepto:
- `documento_de_identidad` ← `Notes.trim()` (antes: `email[:16]`)

### Hash para EntityMapping
`buildHashForMapping` usa `documento_de_identidad: Notes.trim()` en lugar de `email[:16]`.  
El resto de la estructura del hash no cambia.

---

## Categorías de Skip

| Categoría | Razón | ¿Nueva? |
|---|---|---|
| `already_mapped` | Ya tiene EntityMapping en MongoDB | Igual |
| `sin_email` | `PrimaryEmailAddr` vacío o ausente | Renombrada (era `skippedNoEmail`) |
| `email_duplicado` | Email aparece en más de un customer activo de QB | Ampliada (antes solo cohort) |
| `sin_notes` | `Notes` vacío o ausente | **Nueva** |
| `notes_invalido` | `Notes` no empieza con dígito o supera 16 chars | **Nueva** |
| `notes_duplicado` | `Notes.trim()` aparece en más de un customer activo de QB | **Nueva** |
| `failed` | Error de ejecución (API, DB) | Igual |

> `already_mapped` se reporta en consola pero **no se incluye en el CSV** — son skips esperados de corridas anteriores, no problemas a resolver.

---

## Reporte

### JSON (sin cambios de estructura)
El reporte JSON existente se amplía con las nuevas categorías:
```json
{
  "skippedNoNotes": [],
  "skippedInvalidNotes": [],
  "skippedDuplicateNotes": []
}
```
`skippedDuplicateEmail` ahora refleja colisiones contra todos los customers activos (no solo el cohort).

### CSV (nuevo)
Archivo generado junto al JSON: `migration-<timestamp>[-dryrun].csv`  
Separador: `;`  
Incluye todos los skips **excepto** `already_mapped`.

Columnas:
```
qbId;companyName;email;notes;motivo_skip
```

Motivos posibles en la columna `motivo_skip`:
- `sin_email`
- `email_duplicado`
- `sin_notes`
- `notes_invalido`
- `notes_duplicado`
- `error: <mensaje>`

---

## Compatibilidad

- `--dry-run` sigue funcionando: aplica todas las validaciones nuevas y reporta `would_link` / `would_create` sin tocar QB ni HS ni MongoDB.
- `--limit=N` cuenta solo los migrados exitosamente (igual que antes).
- `--tenant` no existe y no se añade (usa `DEFAULT_TENANT_ID`).

---

## Precondiciones (sin cambios)

1. Borrar jobs pendientes en MongoDB
2. Pausar el worker
3. Desactivar webhooks en HubSpot y QuickBooks
4. Backup de la colección `entitymappings`

---

## Control de Rate Limiting

### Análisis de carga

Por cada customer elegible el script hace ~4 llamadas externas: 2-3 a HubSpot + 1 a QuickBooks. MongoDB no tiene rate limit externo relevante.

| Throttle | Tasa HS aprox. | Límite HS | Margen | Duración estimada (1550) |
|---|---|---|---|---|
| 250ms (actual) | ~8.9 req/s | 10 req/s | Estrecho | ~12 min |
| 500ms (nuevo) | ~5.7 req/s | 10 req/s | Cómodo | ~18 min |

### Cambio

`THROTTLE_MS` se incrementa de **250ms a 500ms**.

### Por qué es seguro

- El worker está pausado (precondición 2): cero llamadas concurrentes de sync.
- Los webhooks están desactivados (precondición 3): sin eventos nuevos durante la migración.
- Las únicas llamadas a HS y QB durante la migración son las del script.
- La carga inicial de QB customers (paginado) mantiene su throttle de 300ms entre páginas.

### En caso de 429

Si a pesar del throttle se recibe un error 429, el customer queda en `failed` en el reporte. Para reintentarlos basta con **volver a correr el script sin flags**: los customers ya migrados tienen EntityMapping y son saltados por el check `already_mapped`; los que fallaron no tienen EntityMapping y son reintentados automáticamente. La idempotencia del script hace todo el trabajo. No se añade lógica de retry automático para mantener el script simple.

---

## Lo que NO cambia

- Lógica de paginación de QB customers (1000 por página)
- Estructura del reporte JSON
- Flujo de `processCustomer` (check `already_mapped` primero, luego HS link/create, luego QB update, luego EntityMapping)
- El campo `Notes` de QB no es leído ni escrito por el sync normal — solo la migración lo consume una vez
