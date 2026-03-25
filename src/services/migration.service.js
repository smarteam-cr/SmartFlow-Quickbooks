const hubspotClient = require("../integrations/hubspot/hubspot.client");
const quickbooksClient = require("../integrations/quickbooks/quickbooks.client");

/**
 * Migración masiva B2B: HubSpot → QuickBooks
 *
 * Algoritmo:
 * 1. Extraer Empresas + Contactos + Asociaciones de HubSpot
 * 2. FASE PADRES: Crear empresas como Customers puros en QB (Identity Map)
 * 3. FASE HIJOS: Crear contactos asociados como Sub-customers (con ParentRef)
 * 4. FASE B2C: Crear contactos sin empresa como clientes estándar
 */
async function syncHistoricalContacts() {
  console.log("\n=== INICIANDO MIGRACIÓN B2B: HUBSPOT → QUICKBOOKS ===");

  // ────────────────────────────────────────
  // PASO 1: Extracción masiva de HubSpot
  // ────────────────────────────────────────
  const companies = await hubspotClient.getAllCompanies();
  // USAMOS LA NUEVA FUNCIÓN QUE TRAE LAS ASOCIACIONES INCLUIDAS
  const contacts = await hubspotClient.getAllContactsWithCompanyAssociations();

  const contactToCompanyMap = {};
  const companyNames = {};

  // 1. Mapeamos solo los nombres de las empresas (Sin hacer peticiones HTTP)
  for (const company of companies) {
    companyNames[company.id] =
      company.properties.name ||
      company.properties.domain ||
      `Company-${company.id}`;
  }

  // 2. Extraemos el Padre directamente de la información adjunta del contacto
  for (const contact of contacts) {
    // Verificamos si HubSpot nos mandó asociaciones de empresa para este contacto
    if (
      contact.associations &&
      contact.associations.companies &&
      contact.associations.companies.results.length > 0
    ) {
      // Tomamos el ID de la primera empresa asociada
      contactToCompanyMap[contact.id] =
        contact.associations.companies.results[0].id;
    }
  }

  console.log(
    `\nMapa de asociaciones construido en memoria: ${Object.keys(contactToCompanyMap).length} contactos vinculados a empresas.`,
  );

  // ────────────────────────────────────────
  // PASO 2: IDENTITY MAP (Caché en memoria)
  // { hsCompanyId: qbCustomerId }
  // ────────────────────────────────────────
  const companyIdentityMap = {};
  let stats = {
    empresasCreadas: 0,
    empresasExistentes: 0,
    contactosProcesados: 0,
    contactosB2C: 0,
    saltados: 0,
    errores: 0,
  };

  // ────────────────────────────────────────
  // PASO 3: FASE PADRES — Crear Empresas
  // ────────────────────────────────────────
  console.log("\n--- FASE 1: Procesando Empresas (Padres) ---");

  for (const company of companies) {
    const hsCompanyId = company.id;
    const companyName = companyNames[hsCompanyId];
    const existingQbId = company.properties.id_usuario_quickbooks;

    // Si ya tiene un ID de QuickBooks asignado, lo cacheamos directo
    if (existingQbId) {
      console.log(
        `  ✓ "${companyName}" ya vinculada a QB ID: ${existingQbId}. Cacheando.`,
      );
      companyIdentityMap[hsCompanyId] = existingQbId;
      stats.empresasExistentes++;
      continue;
    }

    console.log(`\n  Procesando empresa: "${companyName}"...`);

    try {
      // Verificamos si ya existe en QB por DisplayName (evita duplicados)
      const existingCustomer =
        await quickbooksClient.findCustomerByDisplayName(companyName);

      let finalCompanyQbId = null; // Variable para atrapar el ID final

      if (existingCustomer) {
        console.log(
          `  ✓ Ya existe en QB (ID: ${existingCustomer.Id}). Reusando.`,
        );
        finalCompanyQbId = existingCustomer.Id;
        stats.empresasExistentes++;
      } else {
        console.log(`  → Creando empresa en QuickBooks...`);
        const newCustomer = await quickbooksClient.createCustomer({
          companyName: companyName,
          hsId: hsCompanyId,
        });
        console.log(`  ✓ Empresa creada en QB con ID: ${newCustomer.Id}`);
        finalCompanyQbId = newCustomer.Id;
        stats.empresasCreadas++;
      }

      // 1. Guardamos en el Caché en memoria para los Hijos
      companyIdentityMap[hsCompanyId] = finalCompanyQbId;

      // 2. ¡EL PASO CRÍTICO! Actualizamos HubSpot SIEMPRE, ya sea nueva o reusada.
      await hubspotClient.updateCompanyProperty(hsCompanyId, finalCompanyQbId);
      console.log(`  ✓ HubSpot actualizado con el QB ID: ${finalCompanyQbId}`);
    } catch (err) {
      console.error(
        `  ✗ Error procesando empresa "${companyName}":`,
        err.message,
      );
      stats.errores++;
    }
  }

  console.log(
    `\nIdentity Map construido: ${Object.keys(companyIdentityMap).length} empresas mapeadas.`,
  );

  // ────────────────────────────────────────
  // PASO 4: FASE HIJOS + B2C — Crear Contactos
  // ────────────────────────────────────────
  console.log("\n--- FASE 2: Procesando Contactos (Hijos + B2C) ---");

  for (const contact of contacts) {
    const contactId = contact.id;
    const {
      email,
      firstname: firstName,
      lastname: lastName,
      id_usuario_quickbooks: existingQbId,
    } = contact.properties;

    // Si ya tiene ID de QuickBooks, saltamos
    if (existingQbId) {
      stats.saltados++;
      continue;
    }

    // Si no tiene email ni nombre, no podemos crear un Customer útil
    if (!email && !firstName && !lastName) {
      console.log(`  → Contacto ${contactId} sin datos útiles. Saltando.`);
      stats.saltados++;
      continue;
    }

    const parentHsCompanyId = contactToCompanyMap[contactId];

    try {
      let finalQbId = null;

      if (parentHsCompanyId && companyIdentityMap[parentHsCompanyId]) {
        // ── SUB-CUSTOMER (Hijo de una empresa) ──
        const qbParentId = companyIdentityMap[parentHsCompanyId];
        const companyName = companyNames[parentHsCompanyId];
        const displayName = `${firstName || ""} ${lastName || ""}`.trim();

        console.log(
          `\n  Procesando contacto: "${displayName}" → Hijo de "${companyName}"...`,
        );

        // Buscar por DisplayName con formato hijo para evitar duplicados
        const childDisplayName = `${displayName} (${companyName})`;
        const existing =
          await quickbooksClient.findCustomerByDisplayName(childDisplayName);

        if (existing) {
          console.log(
            `  ✓ Ya existe en QB como sub-customer (ID: ${existing.Id}).`,
          );
          finalQbId = existing.Id;
        } else {
          const newCustomer = await quickbooksClient.createCustomer({
            firstName,
            lastName,
            email,
            parentRef: qbParentId,
            companyName: companyName,
            hsId: contactId,
          });
          console.log(
            `  ✓ Sub-customer creado en QB con ID: ${newCustomer.Id}`,
          );
          finalQbId = newCustomer.Id;
        }
        stats.contactosProcesados++;
      } else {
        // ── CONTACTO B2C (Sin empresa asociada) ──
        const displayName =
          `${firstName || ""} ${lastName || ""}`.trim() || email;
        console.log(`\n  Procesando contacto B2C: "${displayName}"...`);

        // Buscar por email primero (lógica original preservada)
        if (email) {
          const existingByEmail =
            await quickbooksClient.findCustomerByEmail(email);
          if (existingByEmail) {
            console.log(`  ✓ Ya existe en QB (ID: ${existingByEmail.Id}).`);
            finalQbId = existingByEmail.Id;
          }
        }

        if (!finalQbId) {
          const newCustomer = await quickbooksClient.createCustomer({
            firstName,
            lastName,
            email,
            hsId: contactId,
          });
          console.log(`  ✓ Cliente B2C creado en QB con ID: ${newCustomer.Id}`);
          finalQbId = newCustomer.Id;
        }
        stats.contactosB2C++;
      }

      // Actualizar HubSpot con el ID de QuickBooks generado
      if (finalQbId) {
        await hubspotClient.updateContactProperty(contactId, finalQbId);
      }
    } catch (err) {
      const displayName =
        `${firstName || ""} ${lastName || ""}`.trim() || email || contactId;
      console.error(
        `  ✗ Error procesando contacto "${displayName}":`,
        err.message,
      );
      stats.errores++;
    }
  }

  // ────────────────────────────────────────
  // RESULTADO FINAL
  // ────────────────────────────────────────
  console.log("\n=== MIGRACIÓN B2B FINALIZADA ===");
  console.log(
    `Empresas creadas: ${stats.empresasCreadas} | Existentes: ${stats.empresasExistentes}`,
  );
  console.log(
    `Contactos procesados: ${stats.contactosProcesados} | B2C: ${stats.contactosB2C}`,
  );
  console.log(`Saltados: ${stats.saltados} | Errores: ${stats.errores}`);

  return stats;
}

module.exports = { syncHistoricalContacts };
