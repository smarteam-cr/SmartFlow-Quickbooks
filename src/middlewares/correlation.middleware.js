const { v4: uuidv4 } = require('uuid');

const correlationMiddleware = (request, reply, done) => {
  // Asignamos un ID único a la petición
  request.correlationId = request.headers['x-correlation-id'] || uuidv4();
  
  // Lo devolvemos en las cabeceras de respuesta para que el cliente también lo vea
  reply.header('x-correlation-id', request.correlationId);
  
  done();
};

module.exports = { correlationMiddleware };