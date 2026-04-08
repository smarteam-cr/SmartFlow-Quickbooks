const fastify = require("fastify")({ 
  logger: false, // Usamos nuestro logger personalizado de Winston
  trustProxy: true // Necesario para rate-limit detrás de proxies/ngrok
});
const helmet = require("@fastify/helmet");
const cors = require("@fastify/cors");
const compress = require("@fastify/compress");
const rateLimit = require("@fastify/rate-limit");
const loggerSource = require("./lib/logger.lib");

const webhookRoutes = require("./routes/webhook.routes");
const migrationRoutes = require("./routes/migration.routes.js");

// 1. Registro de Plugins de Seguridad e Infraestructura
fastify.register(helmet, { contentSecurityPolicy: false }); // Helmet para cabeceras de seguridad
fastify.register(cors, { origin: true }); // CORS (ajustar en prod)
fastify.register(compress); // Compresión de respuestas
fastify.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  errorResponseBuilder: (request, context) => ({
    status: 'error',
    message: `Demasiadas peticiones. Intenta de nuevo en ${context.after}`
  })
});

// 2. Manejador Global de Errores (Centralizado)
fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;
  
  // Logueamos el error con Winston
  loggerSource.error(`[GlobalError] ${request.method} ${request.url}`, error);

  // Formato de respuesta consistente
  reply.status(statusCode).send({
    status: 'error',
    message: statusCode === 500 ? 'Error interno del servidor' : error.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
  });
});

// Ruta de prueba
fastify.get("/", async (request, reply) => {
  return { message: "API funcionando satisfactoriamente" };
});

// Registramos nuestras rutas
fastify.register(webhookRoutes, { prefix: "/webhook" });
fastify.register(migrationRoutes);

module.exports = fastify;
