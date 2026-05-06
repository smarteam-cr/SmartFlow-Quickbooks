const authController = require('../controllers/auth.controller');
const { validateApiKey } = require('../middlewares/api-key.middleware');

module.exports = async (fastify) => {
  // Endpoints administrativos: requieren API key.
  // El callback NO se protege con API key porque Intuit lo invoca redirigiendo
  // al navegador del usuario y no puede enviar headers — su autenticación es
  // el state aleatorio validado contra OAuthState.
  fastify.get('/quickbooks/connect', { preHandler: validateApiKey }, authController.connect);
  fastify.get('/quickbooks/callback', authController.callback);
  fastify.get('/quickbooks/status', { preHandler: validateApiKey }, authController.status);
  fastify.post('/quickbooks/disconnect', { preHandler: validateApiKey }, authController.disconnect);

  // Página de destino pública para cuando el cliente desconecta la app desde
  // su portal de QuickBooks Online (My Apps → Disconnect). Intuit redirige el
  // navegador del cliente aquí con ?realmId=... — no es un webhook, es solo
  // una landing page de confirmación. Requerida por el formulario de Intuit
  // para obtener las production keys.
  fastify.get('/quickbooks/disconnected', (_request, reply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QuickBooks desconectado</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #333; }
    h1 { color: #d97706; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>QuickBooks desconectado</h1>
  <p>Tu empresa de QuickBooks ha sido desconectada de la integración SmartFlow.</p>
  <p>Si fue un error o necesitas reconectar, contacta al administrador del sistema.</p>
</body>
</html>`);
  });
};