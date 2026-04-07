const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../lib/logger.lib');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(config.mongo.uri);
    logger.info(`MongoDB conectado: ${conn.connection.host}`);
  } catch (error) {
    logger.error('Error conectando a MongoDB:', error);
    process.exit(1);
  }
};

module.exports = connectDB;