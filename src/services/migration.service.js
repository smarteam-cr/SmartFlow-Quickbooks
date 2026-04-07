const hubspotClient = require("../integrations/hubspot/hubspot.client");
const quickbooksClient = require("../integrations/quickbooks/quickbooks.client");
const logger = require("../lib/logger.lib");

/**
 * Migración masiva B2B: HubSpot → QuickBooks
 */
async function syncHistoricalContacts() {
  logger.info("=== INICIANDO MIGRACIÓN B2B: HUBSPOT → QUICKBOOKS ===");

  try {
    const companies = await hubspotClient.getAllCompanies();
    const contacts = await hubspotClient.getAllContactsWithCompanyAssociations();

    const contactToCompanyMap = {};
    const companyNames = {};

    for (const company of companies) {
      companyNames[company.id] =
        company.properties.name ||
        company.properties.domain ||
        `Company-${company.id}`;
    }

    for (const contact of contacts) {
      if (
        contact.associations &&
        contact.associations.companies &&
        contact.associations.companies.results.length > 0
      ) {
        contactToCompanyMap[contact.id] =
          contact.associations.companies.results[0].id;
      }
    }

    logger.info(`Mapa de asociaciones construido en memoria: ${Object.keys(contactToCompanyMap).length} contactos vinculados.`);

    const companyIdentityMap = {};
    let stats = {
      empresasCreadas: 0,
      empresasExistentes: 0,
      contactosProcesados: 0,
      contactosB2C: 0,
      saltados: 0,
      errores: 0,
    };

    logger.info("--- FASE 1: Procesando Empresas (Padres) ---");

    for (const company of companies) {
      const hsCompanyId = company.id;
      const companyName = companyNames[hsCompanyId];
      const existingQbId = company.properties.id_usuario_quickbooks;

      if (existingQbId) {
        logger.info(`  ✓ "${companyName}" ya vinculada a QB ID: ${existingQbId}. Cacheando.`);
        companyIdentityMap[hsCompanyId] = existingQbId;
        stats.empresasExistentes++;
        continue;
      }

      logger.info(`  Procesando empresa: "${companyName}"...`);

      try {
        const existingCustomer = await quickbooksClient.findCustomerByDisplayName(companyName);
        let finalCompanyQbId = null;

        if (existingCustomer) {
          logger.info(`  ✓ Ya existe en QB (ID: ${existingCustomer.Id}). Reusando.`);
          finalCompanyQbId = existingCustomer.Id;
          stats.empresasExistentes++;
        } else {
          logger.info(`  → Creando empresa en QuickBooks...`);
          const newCustomer = await quickbooksClient.createCustomer({
            companyName: companyName,
            hsId: hsCompanyId,
          });
          logger.info(`  ✓ Empresa creada en QB con ID: ${newCustomer.Id}`);
          finalCompanyQbId = newCustomer.Id;
          stats.empresasCreadas++;
        }

        companyIdentityMap[hsCompanyId] = finalCompanyQbId;
        await hubspotClient.updateCompanyProperty(hsCompanyId, finalCompanyQbId);
        logger.info(`  ✓ HubSpot actualizado con el QB ID: ${finalCompanyQbId}`);
      } catch (err) {
        logger.error(`  ✗ Error procesando empresa "${companyName}":`, err);
        stats.errores++;
      }
    }

    logger.info("--- FASE 2: Procesando Contactos (Hijos + B2C) ---");

    for (const contact of contacts) {
      const contactId = contact.id;
      const {
        email,
        firstname: firstName,
        lastname: lastName,
        id_usuario_quickbooks: existingQbId,
      } = contact.properties;

      if (existingQbId) {
        stats.saltados++;
        continue;
      }

      if (!email && !firstName && !lastName) {
        logger.info(`  → Contacto ${contactId} sin datos útiles. Saltando.`);
        stats.saltados++;
        continue;
      }

      const parentHsCompanyId = contactToCompanyMap[contactId];

      try {
        let finalQbId = null;

        if (parentHsCompanyId && companyIdentityMap[parentHsCompanyId]) {
          const qbParentId = companyIdentityMap[parentHsCompanyId];
          const companyName = companyNames[parentHsCompanyId];
          const displayName = `${firstName || ""} ${lastName || ""}`.trim();

          logger.info(`\n  Procesando contacto: "${displayName}" → Hijo de "${companyName}"...`);

          const childDisplayName = `${displayName} (${companyName})`;
          const existing = await quickbooksClient.findCustomerByDisplayName(childDisplayName);

          if (existing) {
            logger.info(`  ✓ Ya existe en QB como sub-customer (ID: ${existing.Id}).`);
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
            logger.info(`  ✓ Sub-customer creado en QB con ID: ${newCustomer.Id}`);
            finalQbId = newCustomer.Id;
          }
          stats.contactosProcesados++;
        } else {
          const displayName = `${firstName || ""} ${lastName || ""}`.trim() || email;
          logger.info(`\n  Procesando contacto B2C: "${displayName}"...`);

          if (email) {
            const existingByEmail = await quickbooksClient.findCustomerByEmail(email);
            if (existingByEmail) {
              logger.info(`  ✓ Ya existe en QB (ID: ${existingByEmail.Id}).`);
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
            logger.info(`  ✓ Cliente B2C creado en QB con ID: ${newCustomer.Id}`);
            finalQbId = newCustomer.Id;
          }
          stats.contactosB2C++;
        }

        if (finalQbId) {
          await hubspotClient.updateContactProperty(contactId, finalQbId);
        }
      } catch (err) {
        const displayName = `${firstName || ""} ${lastName || ""}`.trim() || email || contactId;
        logger.error(`  ✗ Error procesando contacto "${displayName}":`, err);
        stats.errores++;
      }
    }

    logger.info("=== MIGRACIÓN B2B FINALIZADA ===");
    logger.info(`Resultados: Empresas ${stats.empresasCreadas}/${stats.empresasExistentes} | Contactos ${stats.contactosProcesados}/${stats.contactosB2C} | Saltados ${stats.saltados} | Errores ${stats.errores}`);

    return stats;
  } catch (error) {
    logger.error("❌ Error crítico en migración masiva:", error);
    throw error;
  }
}

module.exports = { syncHistoricalContacts };
