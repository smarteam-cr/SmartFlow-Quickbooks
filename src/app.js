// src/app.js
const fastify = require("fastify")({ 
  logger: false, 
  trustProxy: true 
});
const helmet = require("@fastify/helmet");
const cors = require("@fastify/cors");
const compress = require("@fastify/compress");
const rateLimit = require("@fastify/rate-limit");
const loggerSource = require("./lib/logger.lib");

const webhookRoutes = require("./routes/webhook.routes");
const migrationRoutes = require("./routes/migration.routes.js");
const { correlationMiddleware } = require("./middlewares/correlation.middleware");

// Fastify por defecto destruye el texto original al parsear JSON.
// Necesitamos el texto original (rawBody) para que las firmas HMAC de HubSpot y QuickBooks no fallen.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body; // Guardamos el texto crudo original
  try {
    done(null, JSON.parse(body)); // Luego parseamos normalmente
  } catch (err) {
    done(err);
  }
});

// MIDDLEWARES GLOBALES
// Ejecutar Trazabilidad en cada petición entrante
fastify.addHook('onRequest', correlationMiddleware);

// Loguear cada respuesta HTTP que sale de nuestro servidor
fastify.addHook('onResponse', (request, reply, done) => {
  loggerSource.info(`[HTTP] ${request.method} ${request.url}`, {
    statusCode: reply.statusCode,
    correlationId: request.correlationId,
    durationMs: reply.elapsedTime,
  });
  done();
});

// Seguridad base
fastify.register(helmet, { contentSecurityPolicy: false }); 
fastify.register(cors, { origin: true }); 
fastify.register(compress); 
fastify.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  errorResponseBuilder: (request, context) => ({
    status: 'error',
    message: `Demasiadas peticiones. Intenta de nuevo en ${context.after}`
  })
});

// MANEJADOR DE ERRORES GLOBAL
fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;
  
  loggerSource.error(`[GlobalError] ${request.method} ${request.url}`, {
    message: error.message,
    correlationId: request.correlationId,
    stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
  });

  reply.status(statusCode).send({
    status: 'error',
    message: statusCode === 500 ? 'Error interno del servidor' : error.message,
  });
});

// RUTAS
fastify.get("/", async (request, reply) => {
  return { message: "API funcionando satisfactoriamente" };
});

fastify.register(webhookRoutes, { prefix: "/webhook" });
fastify.register(migrationRoutes);

module.exports = fastify;