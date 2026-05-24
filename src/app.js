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
const authRoutes = require("./routes/auth.routes");
const staticRoutes = require("./routes/static.routes");
const { correlationMiddleware } = require("./middlewares/correlation.middleware");

// Fastify por defecto destruye el texto original al parsear JSON.
// Necesitamos el texto original (rawBody) para que las firmas HMAC de HubSpot y QuickBooks no fallen.
// Registramos para 'application/json' y variantes que Intuit puede enviar con CloudEvents.
const jsonParser = (req, body, done) => {
  req.rawBody = body;
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    done(err);
  }
};
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, jsonParser);
fastify.addContentTypeParser('application/cloudevents+json', { parseAs: 'string' }, jsonParser);
fastify.addContentTypeParser('application/cloudevents-batch+json', { parseAs: 'string' }, jsonParser);

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
  errorResponseBuilder: (_request, context) => ({
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
fastify.get("/", async () => {
  return { message: "API funcionando satisfactoriamente" };
});

fastify.register(staticRoutes);
fastify.register(webhookRoutes, { prefix: "/webhook" });
fastify.register(authRoutes, { prefix: "/auth" });

module.exports = fastify;