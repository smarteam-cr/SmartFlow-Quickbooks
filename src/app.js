const fastify = require("fastify")({ logger: true });
const webhookRoutes = require("./routes/webhook.routes");

//Ruta de prueba
fastify.get("/", async (request, reply) => {
  return { message: "API funcionando correctamente" };
});

// Registramos nuestras rutas en la aplicación
fastify.register(webhookRoutes.webhookRoutes);
fastify.register(webhookRoutes.hubSpotWebhook);

module.exports = fastify;
