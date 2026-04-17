const config = require('./config');
const app = require('./app');
const connectDB = require('./db/database');
const { startWorker } = require('./tasks/worker');
const logger = require('./lib/logger.lib');

const PORT = config.port;

const start = async () => {
  try {
    await connectDB();
   await startWorker();
    await app.listen({ port: PORT });
    logger.info(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  } catch (err) {
    logger.error('Error al iniciar el servidor:', err);
    process.exit(1);
  }
};

start();