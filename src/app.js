const fastify = require("fastify")({ logger: false });
const webhookRoutes = require("./routes/webhook.routes");
const migrationRoutes = require('./routes/migration.routes.js');

//Ruta de prueba
fastify.get("/", async (request, reply) => {
  return { message: "API funcionando satisfactoriamente" };
});

// Registramos nuestras rutas en la aplicación
fastify.register(webhookRoutes, { prefix: '/webhook' });
fastify.register(migrationRoutes);


module.exports = fastify;
