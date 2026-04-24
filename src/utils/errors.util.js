/**
 * Clase base para errores operativos del servidor.
 * Permite capturar stack trace y definir códigos HTTP específicos.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Datos de entrada inválidos', errors = []) {
    super(message, 400);
    this.errors = errors;
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'No autorizado') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Permisos insuficientes') {
    super(message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflicto de estado') {
    super(message, 409);
  }
}

/**
 * Señala que un job debe marcarse como SKIPPED (no es un fallo técnico
 * — es una regla de negocio que aborta limpiamente, sin reintentos).
 */
class SkipJobError extends AppError {
  constructor(message = 'Job omitido por regla de negocio', reason = 'BUSINESS_RULE') {
    super(message, 200, true);
    this.reason = reason;
  }
}

class InactiveCustomerError extends SkipJobError {
  constructor(message = 'Cliente inactivo: se omite la sincronización.') {
    super(message, 'INACTIVE_CUSTOMER');
  }
}

class InactiveParentError extends SkipJobError {
  constructor(message = 'Empresa padre inactiva: no se puede activar el sub-cliente.') {
    super(message, 'INACTIVE_PARENT');
  }
}

class MissingIdentityError extends SkipJobError {
  constructor(message = 'Contacto sin documento_de_identidad: no se puede sincronizar con QuickBooks.') {
    super(message, 'MISSING_IDENTITY');
  }
}

class CurrencyMismatchError extends SkipJobError {
  constructor(message = 'Moneda de factura y moneda_de_preferencia del contacto no coinciden.') {
    super(message, 'CURRENCY_MISMATCH');
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  SkipJobError,
  InactiveCustomerError,
  InactiveParentError,
  MissingIdentityError,
  CurrencyMismatchError,
};
