const responseHelper = {
  success: (data, meta = {}) => ({
    status: 'success',
    data,
    ...meta,
  }),
  error: (message, statusCode = 500, details = null) => ({
    status: 'error',
    message,
    ...(details && { details }),
  }),
  paginated: (data, total, page, limit) => ({
    status: 'success',
    data,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  }),
};

module.exports = { responseHelper };