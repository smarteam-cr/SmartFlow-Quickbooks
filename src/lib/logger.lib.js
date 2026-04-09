const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

/**
 * Professional Observability System - Winston Configuration
 * Complies with SRP: This is the ONLY file importing Winston.
 * V2.0 Ready: New transports can be added easily in the transports array.
 */

// Custom log format for files (JSON)
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }), // Capture stack trace
  winston.format.json()
);

// Custom log format for Console (Readable + Colors)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let msg = `${timestamp} ${level}: ${message}`;
    if (Object.keys(meta).length > 0) {
      try {
        msg += ` ${JSON.stringify(meta)}`;
      } catch (_) {
        msg += ` [objeto no serializable]`;
      }
    }
    if (stack) {
      msg += `\n${stack}`;
    }
    return msg;
  })
);

// Transport Configuration
const transports = [
  // App Log: All levels, 14-day retention, 20MB limit
  new winston.transports.DailyRotateFile({
    filename: 'logs/app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    format: logFormat,
  }),
  // Error Log: Level 'error' only, 30-day retention
  new winston.transports.DailyRotateFile({
    level: 'error',
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    format: logFormat,
  }),
];

// Console Transport: Only if not in production
if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.Console({
    format: consoleFormat,
  }));
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
  // Ensure that uncaught exceptions and rejections are logged
  exceptionHandlers: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/exceptions-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
    })
  ],
  rejectionHandlers: [
    new winston.transports.DailyRotateFile({
      filename: 'logs/rejections-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
    })
  ]
});

module.exports = logger;
