const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

/**
 * Professional Observability System - Winston Configuration
 * Complies with SRP: This is the ONLY file importing Winston.
 * V2.0 Ready: New transports can be added easily in the transports array.
 */

/**
 * Replacer seguro para JSON.stringify: extrae los campos útiles de errores
 * de Axios (response.data con formato QB Fault o HS message) y colapsa
 * referencias circulares. Evita que `JSON.stringify` falle con
 * `[objeto no serializable]`.
 */
function safeReplacer() {
  const seen = new WeakSet();
  return function replacer(key, value) {
    if (value && typeof value === 'object') {
      // Colapsa Axios errors a una forma serializable útil
      if (value.isAxiosError || (value.response && value.response.status && value.config)) {
        const data = value.response && value.response.data;
        let detail = value.message;
        if (data) {
          if (data.Fault && Array.isArray(data.Fault.Error) && data.Fault.Error[0]) {
            const f = data.Fault.Error[0];
            detail = `${f.Detail || f.Message || detail}${f.code ? ` (code=${f.code})` : ''}`;
          } else if (typeof data.message === 'string') {
            detail = data.message;
          } else if (typeof data === 'string') {
            detail = data;
          }
        }
        return {
          axiosError: true,
          status: value.response && value.response.status,
          url: value.config && value.config.url,
          method: value.config && value.config.method,
          detail
        };
      }
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

// Custom log format for files (JSON)
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }), // Capture stack trace
  winston.format.json({ replacer: safeReplacer() })
);

// Custom log format for Console (Readable + Colors)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let msg = `${timestamp} ${level}: ${message}`;
    if (Object.keys(meta).length > 0) {
      try {
        msg += ` ${JSON.stringify(meta, safeReplacer())}`;
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

// Console Transport: siempre activo. En contenedores stdout es la fuente
// primaria de logs (docker logs, kubectl logs, agregadores). Los archivos
// rotados quedan como backup persistente en el bind-mount ./logs.
transports.push(new winston.transports.Console({
  format: consoleFormat,
}));

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
