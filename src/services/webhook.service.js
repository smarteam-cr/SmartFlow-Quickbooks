const quickbooksClient = require('../integrations/quickbooks/quickbooks.client');

/**
 * Procesa el payload (cuerpo) del webhook que envía QuickBooks
 */
async function procesarNotificacion(payload) {
  try {
    // QuickBooks envía un arreglo de notificaciones, lo recorremos
    const notificaciones = payload.eventNotifications;
    
    if (!notificaciones || notificaciones.length === 0) return;

    for (const notificacion of notificaciones) {
      const realmId = notificacion.realmId;
      const eventos = notificacion.dataChangeEvent.entities;

      for (const evento of eventos) {
        // Solo nos interesan los pagos creados
        if (evento.name === 'Payment' && evento.operation === 'Create') {
          const paymentId = evento.id;
          console.log(`🧠 [Service] Procesando nuevo pago con ID: ${paymentId} para el cliente ${realmId}`);

          // En el futuro, aquí iremos a MongoDB a buscar el token de este realmId.
          // Por ahora, para nuestra PoC, usamos el del .env:
          const accessToken = process.env.QB_TEST_ACCESS_TOKEN;

          // ¡Llamamos a nuestra integración para traer el dinero!
          const detallesPago = await quickbooksClient.getPaymentDetails(realmId, paymentId, accessToken);
          
          console.log('✅ [Service] ¡Pago extraído exitosamente de QuickBooks!');
          console.log('💰 Monto:', detallesPago.Payment.TotalAmt);
          // console.log('👤 Cliente Ref:', detallesPago.Payment.CustomerRef.value);
          console.log('👤 Cliente Ref:', detallesPago.Payment);
          
          // El SIGUIENTE paso del proyecto será:
          // await hubspotService.enviarPago(detallesPago)
        }
      }
    }
  } catch (error) {
    console.error('❌ [Service] Error procesando el pago:', error.message);
    throw error; // Lanzamos el error para que el controlador lo atrape si es necesario
  }
}

module.exports = { procesarNotificacion };