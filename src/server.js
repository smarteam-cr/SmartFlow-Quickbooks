require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 3000;

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