// Páginas públicas requeridas por Intuit para registrar la app en producción.
// No tienen lógica — solo responden HTML para que el formulario de Intuit
// pueda validar que las URLs existen y devuelven 200.
module.exports = async (fastify) => {

  // Mostrada en el perfil de la app dentro del portal de Intuit y en la pantalla
  // de autorización OAuth que ve el cliente cuando conecta QuickBooks.
  fastify.get('/privacy', (_request, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Política de Privacidad — SmartFlow</title>
  <style>
    body { font-family: sans-serif; max-width: 640px; margin: 60px auto; padding: 0 24px; color: #333; line-height: 1.7; }
    h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Política de Privacidad</h1>
  <p><strong>Aplicación:</strong> SmartFlow — Integración QuickBooks + HubSpot</p>
  <p><strong>Tipo de uso:</strong> Aplicación privada de uso interno exclusivo.</p>
  <p>Esta integración accede a datos de QuickBooks Online únicamente para sincronizarlos
     con HubSpot CRM en nombre del titular de la cuenta autorizada. No se comparten datos
     con terceros. La información se almacena en servidores privados y se usa exclusivamente
     para la sincronización contable autorizada por el usuario.</p>
  <p>El acceso puede revocarse en cualquier momento desde QuickBooks Online:
     <em>Aplicaciones → Mis Aplicaciones → Desconectar</em>.</p>
  <p><strong>Última actualización:</strong> Mayo 2026</p>
</body>
</html>`);
  });

  // Mostrada en el perfil de la app dentro del portal de Intuit. Establece los
  // términos bajo los cuales el cliente autoriza a la integración a acceder a QB.
  fastify.get('/eula', (_request, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Términos de Uso — SmartFlow</title>
  <style>
    body { font-family: sans-serif; max-width: 640px; margin: 60px auto; padding: 0 24px; color: #333; line-height: 1.7; }
    h1 { border-bottom: 2px solid #e5e7eb; padding-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Términos de Uso (EULA)</h1>
  <p><strong>Aplicación:</strong> SmartFlow — Integración QuickBooks + HubSpot</p>
  <p>Al autorizar esta integración, aceptas que la aplicación accederá a los datos de
     tu empresa en QuickBooks Online para sincronizarlos de forma automatizada con
     HubSpot CRM. El acceso se limita estrictamente a los datos necesarios para
     esta sincronización.</p>
  <p>Esta es una aplicación de uso interno. No está disponible para el público general
     ni se distribuye a terceros.</p>
  <p>Puedes revocar el acceso en cualquier momento desde QuickBooks Online:
     <em>Aplicaciones → Mis Aplicaciones → Desconectar</em>.</p>
  <p><strong>Última actualización:</strong> Mayo 2026</p>
</body>
</html>`);
  });

};
