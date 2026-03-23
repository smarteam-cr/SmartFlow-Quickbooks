const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');
const hubspotClient = require('../integrations/hubspot/hubspot.client');

async function syncCustomersToHubSpot() {
  console.log('\n=== INICIANDO SINCRONIZACIÓN DE PRUEBA QB → HubSpot ===');

  // ── Fase 3: Extracción desde QuickBooks ──
  const qbCustomers = await quickbooksClient.getAllCustomers();

  if (qbCustomers.length === 0) {
    console.log('No se encontraron clientes en QuickBooks Sandbox.');
    return {
      message: 'No hay clientes en QuickBooks para procesar',
      totalLeidos: 0,
      totalFiltrados: 0,
      totalEnviados: 0,
      totalCreados: 0,
      errores: [],
    };
  }

  console.log(`Se encontraron ${qbCustomers.length} clientes en QuickBooks.`);

  // ── Fase 4: Transformación y Mapeo ──
  const contactsMapeados = [];
  let totalFiltrados = 0;

  for (const customer of qbCustomers) {
    const firstName = customer.GivenName || '';
    const lastName = customer.FamilyName || '';
    const email = customer.PrimaryEmailAddr?.Address || '';

    // Filtrado: ignorar si no tiene nombre o email válido
    if (!email || (!firstName && !lastName)) {
      console.log(`Filtrado: cliente "${customer.DisplayName}" sin email o nombre válido.`);
      totalFiltrados++;
      continue;
    }

    contactsMapeados.push({
      properties: {
        firstname: firstName,
        lastname: lastName,
        email: email,
      },
    });
  }

  console.log(`Contactos mapeados para HubSpot: ${contactsMapeados.length} (filtrados: ${totalFiltrados})`);

  if (contactsMapeados.length === 0) {
    return {
      message: 'Todos los clientes fueron filtrados (sin email o nombre válido)',
      totalLeidos: qbCustomers.length,
      totalFiltrados,
      totalEnviados: 0,
      totalCreados: 0,
      errores: [],
    };
  }

  // ── Fase 5: Inyección a HubSpot vía Batch API ──
  const hubspotResponse = await hubspotClient.batchCreateContacts(contactsMapeados);

  // ── Fase 6: Consolidar resultados ──
  const totalCreados = hubspotResponse.results?.length || 0;
  const errores = hubspotResponse.errors || [];

  if (errores.length > 0) {
    console.log(`HubSpot reportó ${errores.length} error(es) en el batch.`);
  }

  console.log('=== SINCRONIZACIÓN DE PRUEBA FINALIZADA ===\n');

  return {
    message: 'Sincronización de prueba completada',
    totalLeidos: qbCustomers.length,
    totalFiltrados,
    totalEnviados: contactsMapeados.length,
    totalCreados,
    errores: errores.map(err => ({
      categoria: err.category || 'UNKNOWN',
      mensaje: err.message || JSON.stringify(err),
    })),
  };
}

module.exports = { syncCustomersToHubSpot };
