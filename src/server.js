const config = require('./config');
const app = require('./app');

const PORT = config.port;

const start = async () => {
  try {
    // Aquí en el futuro irá la conexión a MongoDB: await database.connect()
    
    await app.listen({ port: PORT });
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();