const config = require('./config');
const app = require('./app');
const connectDB = require('./db/database');
const { startWorker } = require('./tasks/worker');

const PORT = config.port;

const start = async () => {
  try {
    await connectDB();
    await startWorker();
    await app.listen({ port: PORT });
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();