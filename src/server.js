const config = require('./config');
const app = require('./app');
const connectDB = require('./db/database');
const { startWorker } = require('./tasks/worker');
const logger = require('./lib/logger.lib');

const PORT = config.port;
const HOST = '0.0.0.0';

const start = async () => {
  try {
    // 1. Conectar DB
    await connectDB();
    logger.info('✅ MongoDB conectado');

    // 2. Levantar servidor HTTP
    await app.listen({ port: PORT, host: HOST });
    logger.info(`🚀 Servidor corriendo en http://${HOST}:${PORT}`);

    // 3. Levantar worker (DESPUÉS del server)
    await startWorker();
    logger.info('👷 Worker iniciado');

  } catch (err) {
    logger.error('❌ Error al iniciar el servidor:', err);
    process.exit(1);
  }
};

start();