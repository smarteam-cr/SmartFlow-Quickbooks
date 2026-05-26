# Guía de Usuario: Integración HubSpot — QuickBooks

---

## Tabla de Contenidos

1. [Introducción](#1-introducción)
2. [¿Cómo Funciona la Integración?](#2-cómo-funciona-la-integración)
3. [Contactos](#3-contactos)
4. [Empresas (Compañías)](#4-empresas-compañías)
5. [Productos](#5-productos)
6. [Facturas](#6-facturas)
7. [Pagos](#7-pagos)
8. [Configuraciones que Requieren Coordinación](#8-configuraciones-que-requieren-coordinación)
9. [Solución de Problemas](#9-solución-de-problemas)
10. [Buenas Prácticas y Recomendaciones](#10-buenas-prácticas-y-recomendaciones)
11. [Preguntas Frecuentes](#11-preguntas-frecuentes)

---

## 1. Introducción

Esta integración conecta **HubSpot** (su plataforma de CRM y ventas) con **QuickBooks** (su plataforma de contabilidad) de forma automática y bidireccional. Esto significa que los datos que usted registra en una plataforma se sincronizan automáticamente a la otra, eliminando la necesidad de ingresar la misma información dos veces.

### ¿Qué se sincroniza?

| Elemento | HubSpot → QuickBooks | QuickBooks → HubSpot |
|----------|:-------------------:|:--------------------:|
| Contactos | Si | Si |
| Empresas | Si | Si |
| Productos | Si | Si |
| Facturas | Si | Solo notificación de envío |
| Pagos | Si | — |

### Principio fundamental

La integración está diseñada para **proteger la integridad de sus datos**. Esto significa que si detecta que algo no está correcto (por ejemplo, una moneda que no coincide o un campo obligatorio vacío), **no realizará la sincronización** y dejará un registro del motivo. Esto no es un error del sistema, sino una protección para evitar que datos incorrectos lleguen a su contabilidad.

---

## 2. ¿Cómo Funciona la Integración?

### Sincronización bidireccional

Cuando usted crea o modifica un contacto, empresa o producto en **cualquiera** de las dos plataformas, la integración detecta el cambio automáticamente y lo replica en la otra plataforma.

**Ejemplo:**
- Usted crea un contacto en HubSpot → aparece automáticamente como cliente en QuickBooks.
- Usted actualiza el teléfono de un cliente en QuickBooks → se actualiza automáticamente en HubSpot.

### Sincronización unidireccional (Facturas y Pagos)

- Las **facturas** se sincronizan de HubSpot hacia QuickBooks únicamente cuando están completamente pagadas (saldo pendiente = 0).
- Los **pagos** se sincronizan de HubSpot hacia QuickBooks.
- Cuando una factura es **enviada por correo** desde QuickBooks, HubSpot recibe la notificación y marca la factura como enviada.

### ¿Cuánto tarda la sincronización?

La sincronización ocurre en segundos. Desde que usted guarda un cambio en una plataforma, generalmente tarda entre **5 y 30 segundos** en reflejarse en la otra.

---

## 3. Contactos

Los contactos en HubSpot se sincronizan como **Clientes** en QuickBooks. A continuación se detalla lo que necesita saber para que la sincronización funcione correctamente.

### 3.1 Campos obligatorios

Para que un contacto se sincronice exitosamente, los siguientes campos son **obligatorios**:

| Campo en HubSpot | Descripción | Obligatorio |
|-------------------|-------------|:-----------:|
| **Documento de identidad** (`documento_de_identidad`) | Cédula, pasaporte u otro documento de identificación del contacto | **Si** |
| Nombre (`firstname`) | Nombre del contacto | Recomendado |
| Apellido (`lastname`) | Apellido del contacto | Recomendado |
| Correo electrónico (`email`) | Email del contacto | Recomendado |

> **Importante:** El campo **Documento de identidad** es el campo más crítico de la integración. Sin este campo, el contacto **no se sincronizará** bajo ninguna circunstancia. Este campo es el que permite identificar de manera única a cada contacto entre ambas plataformas.

### 3.2 Limitaciones del Documento de identidad

- El campo tiene un **límite máximo de 16 caracteres** en QuickBooks. Si ingresa un documento más largo en HubSpot, se utilizarán solo los primeros 16 caracteres.
- Debe ser **único** para cada contacto. Dos contactos no pueden tener el mismo documento de identidad.

### 3.3 Moneda de preferencia

Cada contacto puede tener asignada una **moneda de preferencia** (campo `moneda_de_preferencia` en HubSpot).

**Reglas importantes sobre la moneda:**

- La moneda del cliente en QuickBooks es **permanente e inmodificable** una vez creado. No se puede cambiar desde ninguna plataforma después de la creación.
- Si crea un contacto en HubSpot **sin** asignar moneda, QuickBooks le asignará la moneda predeterminada de su cuenta (normalmente USD). La integración escribirá esta moneda de vuelta en HubSpot automáticamente.
- Si intenta cambiar la moneda de un contacto en HubSpot después de que ya fue creado en QuickBooks, **la integración revertirá el cambio** en HubSpot para mantener la coherencia. QuickBooks es la fuente de verdad para la moneda.
- La moneda del contacto es crucial porque **las facturas deben coincidir** con la moneda del cliente.

### 3.4 Estado del contacto (Activo / Inactivo)

El campo `estado_del_contacto_qb` en HubSpot refleja si el cliente está activo o inactivo en QuickBooks.

- Un contacto **inactivo** no puede recibir facturas ni pagos. La integración bloqueará cualquier intento de crear factura o pago para un contacto inactivo.
- Si desactiva un contacto en HubSpot, se desactivará en QuickBooks y viceversa.

**Caso especial — Contactos asociados a una empresa:**
Si un contacto está vinculado a una empresa (como sub-cliente en QuickBooks) y la empresa está **inactiva**, no podrá activar el contacto individualmente. Primero debe activar la empresa y luego el contacto. Si intenta activar el contacto, la integración revertirá el estado a "inactivo" automáticamente y le avisará del motivo.

### 3.5 Asociación con empresas (Sub-clientes)

Cuando un contacto en HubSpot está asociado a una empresa, en QuickBooks se creará como un **sub-cliente** de esa empresa. Esto permite organizar clientes dentro de empresas en su contabilidad.

**Requisito de moneda:** El contacto y la empresa deben tener la **misma moneda**. Si las monedas no coinciden, el contacto se creará como un cliente independiente en QuickBooks (no como sub-cliente), pero la asociación en HubSpot se mantendrá.

### 3.6 Campos sincronizados

| HubSpot | QuickBooks | Dirección |
|---------|------------|:---------:|
| Nombre | GivenName | Bidireccional |
| Apellido | FamilyName | Bidireccional |
| Email | PrimaryEmailAddr | Bidireccional |
| Teléfono | PrimaryPhone | Bidireccional |
| WhatsApp | Mobile | Bidireccional |
| Dirección, Ciudad, Estado, CP, País | BillAddr | Bidireccional |
| Documento de identidad | Suffix | Bidireccional |
| Estado del contacto QB | Active | Bidireccional |
| Moneda de preferencia | CurrencyRef | Bidireccional (solo en creación) |

---

## 4. Empresas (Compañías)

Las empresas en HubSpot se sincronizan como **Clientes tipo empresa** en QuickBooks.

### 4.1 Campos obligatorios

| Campo en HubSpot | Descripción | Obligatorio |
|-------------------|-------------|:-----------:|
| **NIT** (`nit`) | Número de Identificación Tributaria de la empresa | **Si** |
| Nombre de la empresa (`name`) | Nombre comercial o razón social | Recomendado |

> **Importante:** Al igual que con los contactos, el **NIT** es absolutamente obligatorio. Sin este campo, la empresa **no se sincronizará**. El NIT es el identificador único que conecta la empresa entre ambas plataformas.

### 4.2 Campos sincronizados

| HubSpot | QuickBooks | Dirección |
|---------|------------|:---------:|
| Nombre | CompanyName / DisplayName | Bidireccional |
| NIT | AlternatePhone | Bidireccional |
| Teléfono | PrimaryPhone | Bidireccional |
| Dominio web | WebAddr | Bidireccional |
| Dirección, Ciudad, Estado, CP, País | BillAddr | Bidireccional |

### 4.3 Cómo se muestra en QuickBooks

En QuickBooks, el nombre visible de la empresa se construye como: **"Nombre de la Empresa NIT"**. Por ejemplo, si la empresa se llama "Comercial ABC" y su NIT es "123456789", en QuickBooks aparecerá como **"Comercial ABC 123456789"**. Esto permite buscar empresas tanto por nombre como por NIT.

---

## 5. Productos

Los productos se sincronizan bidireccionalmente entre HubSpot y QuickBooks. Pueden crearse en cualquiera de las dos plataformas.

### 5.1 Campos obligatorios (para creación desde HubSpot)

Para crear un producto desde HubSpot que se sincronice a QuickBooks, se requieren los siguientes campos:

| Campo en HubSpot | Descripción | Obligatorio |
|-------------------|-------------|:-----------:|
| **Nombre** (`name`) | Nombre del producto o servicio | **Si** |
| **Precio USD** (`hs_price_usd`) | Precio unitario del producto | **Si** |
| **Cuenta de ingresos** (`cuenta_de_ingresos`) | Cuenta contable de QuickBooks donde se registrarán los ingresos | **Si** |
| **Tipo de producto** (`hs_product_type`) | Tipo: Servicio o No-Inventario | **Si** |
| SKU (`hs_sku`) | Código de referencia del producto | Opcional |
| Descripción (`description`) | Descripción del producto | Opcional |
| Impuesto sobre las ventas (`impuesto_sobre_las_ventas`) | Código de impuesto aplicable | Recomendado |

### 5.2 Tipos de producto permitidos

| Tipo en HubSpot | Tipo en QuickBooks | ¿Se puede crear desde HubSpot? |
|-----------------|-------------------:|:------------------------------:|
| Servicio (`service`) | Service | Si |
| No-Inventario (`non_inventory`) | NonInventory | Si |
| Inventario (`inventory`) | Inventory | **No** |

> **Importante sobre productos de Inventario:** Los productos de tipo **Inventario** (con control de stock) **solo pueden crearse y gestionarse directamente en QuickBooks**. Esto se debe a que requieren campos de seguimiento de stock que HubSpot no maneja. Si intenta crear o cambiar un producto a tipo "inventory" desde HubSpot, la sincronización lo omitirá.

### 5.3 Productos creados desde QuickBooks

Cuando un producto se crea en QuickBooks, se sincroniza automáticamente a HubSpot con toda su información. Sin embargo, los siguientes tipos de elementos de QuickBooks **no se sincronizan**: Categorías, Grupos y Paquetes (Bundles), ya que no tienen equivalente en HubSpot.

### 5.4 Cuenta de ingresos e Impuesto sobre las ventas

Estos dos campos conectan el producto con la configuración contable de QuickBooks:

- **Cuenta de ingresos**: Define en qué cuenta contable de QuickBooks se registrarán los ingresos por venta de este producto. Las opciones disponibles en el dropdown de HubSpot corresponden directamente a los IDs de cuentas en QuickBooks.
- **Impuesto sobre las ventas**: Define qué código de impuesto se aplicará. Igualmente, las opciones corresponden a los códigos de impuesto configurados en QuickBooks.

> Si un producto ya existe en QuickBooks y no tiene estos campos configurados en HubSpot, al actualizarlo desde HubSpot se conservarán los valores que ya tenía en QuickBooks (no se borrarán).

### 5.5 Productos inactivos en QuickBooks

Si un producto se marca como inactivo en QuickBooks, las actualizaciones desde HubSpot **no se aplicarán**. Para volver a sincronizar cambios, el producto debe reactivarse directamente en QuickBooks.

---

## 6. Facturas

Las facturas son el flujo más sensible de la integración. Se sincronizan **únicamente de HubSpot a QuickBooks** y solo cuando cumplen condiciones estrictas.

### 6.1 ¿Cuándo se sincroniza una factura?

Una factura se sincroniza de HubSpot a QuickBooks **únicamente cuando se cumplen TODAS estas condiciones**:

1. El **saldo pendiente** (`hs_balance_due`) es igual a **0** (factura completamente pagada en HubSpot).
2. El **monto facturado** (`hs_amount_billed`) es **mayor a 0** (la factura tiene un monto real).
3. La factura tiene al menos **un contacto asociado**.
4. La factura tiene al menos **una partida** (línea de producto).

> **¿Por qué solo se sincronizan facturas pagadas?** Esto es por diseño. La integración espera a que la factura esté completamente saldada en HubSpot antes de crear el registro contable en QuickBooks. Esto garantiza que QuickBooks refleje operaciones finalizadas.

### 6.2 Requisitos previos para la factura

Antes de que una factura pueda sincronizarse, se deben cumplir estos requisitos:

#### A. El contacto debe estar sincronizado y activo
- El contacto asociado a la factura debe existir en QuickBooks (ya sincronizado).
- El contacto debe estar en estado **activo**. Las facturas para contactos inactivos se bloquean automáticamente.

#### B. Las monedas deben coincidir
La integración realiza una validación de moneda en múltiples niveles:

| Validación | Qué se compara | ¿Por qué? |
|------------|---------------|------------|
| Nivel 1 | Moneda de la factura vs. Moneda de preferencia del contacto (en HubSpot) | Evita inconsistencias internas |
| Nivel 2 | Moneda de la factura vs. Moneda del cliente en QuickBooks | Garantiza compatibilidad con QB |

Si alguna de estas validaciones falla, la factura **no se sincroniza** y se registra el motivo. Ver la sección de [Solución de Problemas](#9-solución-de-problemas) para más detalles.

#### C. Los productos deben existir y tener impuesto configurado
- Cada línea de la factura debe tener un producto que exista en QuickBooks (o que pueda crearse automáticamente).
- Cada línea debe tener un **código de impuesto** (`hs_tax_rate_group_id`) seleccionado.
- El código de impuesto de cada línea debe estar **registrado en la configuración de mapeo de impuestos** (ver sección 8).
- El código de impuesto mapeado debe coincidir con el impuesto configurado en el producto de QuickBooks.

### 6.3 Numeración de facturas

La integración genera automáticamente el número de factura en QuickBooks, respetando la secuencia y el formato existente. Por ejemplo, si la última factura fue "000648", la siguiente será "000649" (preservando los ceros a la izquierda).

### 6.4 ¿Qué se escribe de vuelta en HubSpot?

Una vez que la factura se crea exitosamente en QuickBooks, se actualizan los siguientes campos en HubSpot:
- **ID de factura QuickBooks** (`id_factura_quickbooks`)
- **Número de factura QB** (`numero_factura_qb`)
- **Estado de la factura** (`estado_de_la_factura`)

### 6.5 Facturas enviadas desde QuickBooks

Cuando usted envía una factura por correo electrónico desde QuickBooks, HubSpot recibe una notificación y actualiza el estado de la factura correspondiente.

---

## 7. Pagos

Los pagos registrados en HubSpot se sincronizan como **Pagos** en QuickBooks.

### 7.1 Requisitos para la sincronización de pagos

| Requisito | Descripción |
|-----------|-------------|
| Contacto activo | El contacto asociado debe estar activo en ambas plataformas |
| Factura asociada | El pago **debe** estar asociado a al menos una factura en HubSpot |
| Moneda consistente | La moneda del pago, del contacto y de las facturas asociadas deben coincidir |
| Monto mayor a 0 | Pagos con monto cero o negativo se omiten automáticamente |

> **Importante:** Los pagos en HubSpot **deben registrarse desde los detalles de la factura**. Si un pago no tiene factura asociada, la integración lo rechazará con un mensaje indicando que debe registrarse desde la factura.

### 7.2 ¿Cómo funciona el pago en QuickBooks?

1. El pago se crea en QuickBooks como un **pago sin aplicar** (unapplied payment).
2. Cuando la factura correspondiente se sincroniza a QuickBooks, la integración vincula automáticamente el pago con la factura usando el número de referencia.
3. El pago se deposita en la **cuenta bancaria** configurada para la moneda correspondiente (ver sección 8.2).

### 7.3 Campos sincronizados

| HubSpot | QuickBooks |
|---------|------------|
| Monto total cobrado | TotalAmt |
| Número de referencia | PaymentRefNum |
| Comentario interno | PrivateNote |
| Fecha del pago | TxnDate |
| Contacto asociado | CustomerRef |

---

## 8. Configuraciones que Requieren Coordinación

Algunas configuraciones de la integración deben ser gestionadas por el equipo técnico. Si necesita realizar cambios en alguna de estas áreas, por favor contáctenos.

### 8.1 Mapeo de impuestos (Tax Mappings)

La integración necesita saber qué código de impuesto de HubSpot corresponde a qué código de impuesto de QuickBooks. Esta relación se configura manualmente.

**¿Qué significa esto para usted?**

- Cada tipo de impuesto que utilice en sus facturas debe estar **registrado** en esta configuración.
- Si su empresa agrega un **nuevo tipo de impuesto** (por ejemplo, un impuesto especial para un nuevo tipo de servicio), debe notificarnos para que lo agreguemos al mapeo.
- Si intenta crear una factura con un impuesto que no está mapeado, **la factura no se sincronizará**.

**¿Cuándo contactarnos?**
- Cuando cree un nuevo tipo de impuesto en QuickBooks.
- Cuando cree un nuevo código de impuesto en los dropdowns de HubSpot.
- Cuando necesite vincular un impuesto de HubSpot con uno diferente de QuickBooks.

### 8.2 Cuentas de depósito por moneda (Deposit Accounts)

Los pagos se depositan automáticamente en la cuenta bancaria de QuickBooks que corresponda a la moneda del pago. Esta configuración mapea cada moneda a una cuenta bancaria específica.

**Ejemplo:**
| Moneda | Cuenta bancaria en QuickBooks |
|--------|-------------------------------|
| USD | Cuenta Bancaria en Dólares |
| CRC | Cuenta Bancaria en Colones |

**¿Cuándo contactarnos?**
- Cuando agregue una **nueva moneda** a sus operaciones.
- Cuando abra una **nueva cuenta bancaria** en QuickBooks que deba recibir depósitos.
- Cuando desee cambiar la cuenta bancaria de destino para una moneda existente.

> Si un pago se realiza en una moneda que no tiene cuenta configurada, QuickBooks lo depositará en su cuenta predeterminada y se generará un aviso en los registros del sistema.

### 8.3 Cuentas de ingresos para productos

Las opciones disponibles en el campo "Cuenta de ingresos" del dropdown de productos en HubSpot corresponden a cuentas contables reales de QuickBooks. Si crea una nueva cuenta de ingresos en QuickBooks y desea que esté disponible en HubSpot, debe notificarnos para agregar la opción al dropdown correspondiente.

---

## 9. Solución de Problemas

La integración está diseñada para proteger sus datos. Muchas situaciones que parecen "fallos" son en realidad **protecciones intencionales** que evitan que datos incorrectos lleguen a su contabilidad. A continuación encontrará los escenarios más comunes y cómo resolverlos.

---

### 9.1 Un contacto no se sincronizó a QuickBooks

**Síntoma:** Creó o actualizó un contacto en HubSpot pero no aparece en QuickBooks.

| Posible causa | Solución |
|---------------|----------|
| El campo **Documento de identidad** está vacío | Agregue el número de documento de identidad del contacto en HubSpot. Este campo es obligatorio para la sincronización. |
| El documento de identidad es **idéntico** al de otro contacto | Verifique que no haya otro contacto con el mismo número de documento. Cada contacto debe tener un documento único. |
| El contacto ya existe en QuickBooks con los mismos datos | No es un fallo. Si los datos son idénticos, la integración no realiza cambios innecesarios (optimización). |

---

### 9.2 Una empresa no se sincronizó a QuickBooks

**Síntoma:** Creó una empresa en HubSpot pero no aparece en QuickBooks.

| Posible causa | Solución |
|---------------|----------|
| El campo **NIT** está vacío | Agregue el NIT de la empresa en HubSpot. Este campo es obligatorio. |
| El NIT es idéntico al de otra empresa | Verifique que no haya otra empresa con el mismo NIT. |

---

### 9.3 Una factura no se sincronizó a QuickBooks

Este es el escenario más común de consulta. La integración aplica múltiples validaciones antes de crear una factura en QuickBooks.

**Síntoma:** La factura existe en HubSpot pero no aparece en QuickBooks.

#### Verificaciones paso a paso:

**Paso 1: ¿La factura está completamente pagada?**
- Verifique que el campo **Saldo pendiente** (`hs_balance_due`) sea exactamente **0**.
- Verifique que el **Monto facturado** (`hs_amount_billed`) sea **mayor a 0**.
- Si la factura aún tiene saldo pendiente, esto es normal: la integración espera a que esté completamente saldada.

**Paso 2: ¿La factura tiene un contacto asociado?**
- Abra la factura en HubSpot y verifique que tenga al menos un contacto vinculado.
- Sin contacto asociado, la integración no puede determinar a qué cliente de QuickBooks asignar la factura.

**Paso 3: ¿El contacto está activo?**
- Verifique que el campo **Estado del contacto QB** del contacto asociado sea **"active"** (activo).
- Si el contacto está inactivo, la integración bloquea la creación de facturas para proteger la integridad de QuickBooks. Active el contacto primero.

**Paso 4: ¿Las monedas coinciden?**
- Verifique que la **moneda de la factura** coincida con la **moneda de preferencia** del contacto asociado.
- Verifique que la moneda del contacto en HubSpot coincida con la moneda del cliente en QuickBooks.
- Si hay discrepancia, corrija la moneda en la factura o contacte al equipo técnico. Recuerde: la moneda del cliente en QuickBooks no se puede cambiar.

**Paso 5: ¿Las líneas de la factura tienen impuesto seleccionado?**
- Cada línea de producto en la factura debe tener un **grupo de impuesto** (`hs_tax_rate_group_id`) seleccionado.
- Si alguna línea no tiene impuesto, seleccione el impuesto correspondiente.

**Paso 6: ¿El impuesto está mapeado?**
- El impuesto seleccionado en la línea debe estar registrado en la configuración de mapeo de impuestos.
- Si recientemente agregó un nuevo tipo de impuesto, es posible que aún no haya sido configurado. Contacte al equipo técnico para verificar.

**Paso 7: ¿El impuesto coincide con el del producto en QuickBooks?**
- El código de impuesto mapeado debe coincidir con el impuesto que el producto tiene configurado en QuickBooks.
- Si no coinciden, actualice el impuesto del producto en QuickBooks o seleccione el impuesto correcto en la línea de la factura.

**Paso 8: ¿La factura tiene al menos una línea de producto?**
- Las facturas sin líneas de producto (vacías) no se sincronizan.

---

### 9.4 Un pago no se sincronizó a QuickBooks

**Síntoma:** Registró un pago en HubSpot pero no aparece en QuickBooks.

| Posible causa | Solución |
|---------------|----------|
| El pago **no está asociado** a ninguna factura | Registre el pago desde los detalles de la factura en HubSpot. Los pagos sueltos (sin factura) no se sincronizan. |
| El contacto asociado está **inactivo** | Active el contacto antes de registrar el pago. |
| La **moneda** del pago no coincide con la del contacto o la factura | Verifique que las monedas sean coherentes entre el pago, la factura y el contacto. |
| El monto del pago es **0 o negativo** | Verifique que el monto del pago sea correcto y mayor a cero. |
| Las facturas asociadas tienen **monedas diferentes** | Si el pago está asociado a varias facturas, todas deben tener la misma moneda. |

---

### 9.5 Un producto no se sincronizó desde HubSpot a QuickBooks

**Síntoma:** Creó un producto en HubSpot pero no aparece en QuickBooks.

| Posible causa | Solución |
|---------------|----------|
| Falta el **nombre** del producto | Agregue un nombre al producto en HubSpot. |
| Falta el **precio** (`hs_price_usd`) | Ingrese el precio unitario del producto. |
| Falta la **cuenta de ingresos** (`cuenta_de_ingresos`) | Seleccione la cuenta de ingresos correspondiente en el dropdown. |
| Falta el **tipo de producto** (`hs_product_type`) | Seleccione "Servicio" o "No-Inventario" como tipo de producto. |
| El tipo es **Inventario** | Los productos de inventario deben crearse directamente en QuickBooks. Cambie el tipo a "Servicio" o "No-Inventario" si no requiere control de stock. |
| El producto está **inactivo** en QuickBooks | Los productos inactivos en QuickBooks no pueden actualizarse. Reactívelo directamente en QuickBooks. |

---

### 9.6 La moneda de un contacto cambió en HubSpot pero volvió al valor anterior

**Esto no es un error.** La moneda de un cliente en QuickBooks es **permanente e inmodificable** una vez creada. Si intenta cambiar la moneda de preferencia en HubSpot, la integración la revertirá automáticamente al valor que tiene en QuickBooks para mantener la coherencia.

**Si necesita un cliente con una moneda diferente**, debe crear un nuevo contacto con la moneda deseada.

---

### 9.7 Un contacto se revertió a "inactivo" automáticamente

**Esto no es un error.** Si el contacto es sub-cliente de una empresa que está **inactiva** en QuickBooks, no puede activarse individualmente. La solución es:

1. Primero active la empresa (compañía madre) en QuickBooks.
2. Luego active el contacto.

---

### 9.8 Un contacto no se creó como sub-cliente de su empresa

**Posible causa:** La moneda del contacto es diferente a la moneda de la empresa madre. QuickBooks requiere que los sub-clientes tengan la misma moneda que su empresa. En este caso, el contacto se crea como cliente independiente, pero la asociación en HubSpot se conserva.

---

## 10. Buenas Prácticas y Recomendaciones

### Para Contactos
- **Siempre complete el Documento de identidad** antes de guardar un nuevo contacto. Es el campo más importante para la integración.
- **Defina la moneda de preferencia al crear** el contacto. Una vez creado en QuickBooks, la moneda no se puede cambiar.
- Complete el nombre, apellido y correo electrónico para una mejor identificación en ambas plataformas.

### Para Empresas
- **Siempre ingrese el NIT** al crear una empresa. Sin él, la empresa no se sincronizará.
- Verifique que el NIT sea correcto y único antes de guardar.

### Para Productos
- Defina siempre la **cuenta de ingresos** y el **impuesto sobre las ventas** al crear productos desde HubSpot.
- Use los tipos "Servicio" o "No-Inventario" para productos creados desde HubSpot.
- Si necesita un producto de tipo Inventario, créelo directamente en QuickBooks.

### Para Facturas
- Asegúrese de que el contacto asociado tenga la **misma moneda** que la factura.
- Seleccione el **impuesto** en cada línea de producto de la factura.
- Verifique que todos los productos de la factura existan y estén activos.
- Recuerde que la factura se sincronizará automáticamente cuando el saldo pendiente llegue a 0.

### Para Pagos
- **Registre los pagos desde los detalles de la factura** en HubSpot, no como pagos independientes.
- Asegúrese de que la moneda sea coherente entre pago, factura y contacto.

### Generales
- **No modifique** los campos que terminan en "quickbooks" o "qb" en HubSpot (como `id_usuario_quickbooks`, `id_producto_quickbooks`, `numero_factura_qb`, etc.). Estos campos son gestionados automáticamente por la integración.
- Si necesita agregar un **nuevo impuesto**, una **nueva cuenta de ingresos** o una **nueva moneda**, contacte al equipo técnico para que actualice la configuración.
- Los cambios en ambas plataformas se reflejan generalmente en **menos de 30 segundos**. Si pasados 2 minutos no ve el cambio, consulte esta guía de solución de problemas.

---

## 11. Preguntas Frecuentes

### ¿Puedo crear registros en cualquiera de las dos plataformas?

**Contactos, empresas y productos:** Sí, puede crearlos tanto en HubSpot como en QuickBooks. La integración los sincronizará en ambas direcciones.

**Facturas:** Solo se crean en HubSpot y se sincronizan a QuickBooks cuando están pagadas.

**Pagos:** Solo se crean en HubSpot y se sincronizan a QuickBooks.

---

### ¿Qué pasa si modifico un registro en ambas plataformas al mismo tiempo?

La integración procesa los cambios en orden de llegada. El último cambio es el que prevalecerá. Para evitar conflictos, se recomienda realizar las modificaciones en una sola plataforma a la vez.

---

### ¿Puedo eliminar un registro sincronizado?

La integración **no sincroniza eliminaciones**. Si elimina un contacto en HubSpot, seguirá existiendo en QuickBooks y viceversa. Para desactivar un registro, use el campo de estado (activo/inactivo) en lugar de eliminarlo.

---

### ¿Qué campos de HubSpot no debo modificar manualmente?

Los siguientes campos son gestionados automáticamente por la integración. **No los modifique manualmente**, ya que puede causar inconsistencias:

- `id_usuario_quickbooks`
- `id_producto_quickbooks`
- `id_factura_quickbooks`
- `numero_factura_qb`
- `qb_sync_token`
- `qb_total_amount`
- `qb_tax_amount`
- `saldo_pendiente_qb`
- `qb_discount_amount`
- `estado_de_la_factura`
- `importe_pagado_qb`

---

### ¿Qué pasa si agrego un nuevo impuesto o cuenta bancaria?

Debe contactar al equipo técnico para que lo registren en la configuración de la integración. Sin este paso, las facturas o pagos que utilicen el nuevo impuesto o moneda no se sincronizarán.

---

### ¿La integración funciona en tiempo real?

Sí, la integración detecta los cambios en segundos y los procesa automáticamente. En condiciones normales, los cambios se reflejan en la otra plataforma en menos de 30 segundos.

---

### ¿Qué pasa si QuickBooks o HubSpot están temporalmente fuera de servicio?

La integración tiene un sistema de reintentos automático. Si un servicio no está disponible temporalmente, la integración volverá a intentar la operación automáticamente (hasta 3 veces con intervalos crecientes). Los datos no se pierden.

---

*Documento generado por el equipo de SmartFlow. Para soporte técnico o configuraciones, contacte al equipo de desarrollo.*
