/**
 * Custom error class for API errors
 */
class APIError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Handle errors and return consistent response
 */
function handleError(error, res, context = {}) {
  console.error(`[${new Date().toISOString()}] Error in ${context.endpoint || 'unknown'}:`, {
    message: error.message,
    code: error.code,
    statusCode: error.statusCode,
    details: error.details,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    context,
  });

  const isDevelopment = process.env.NODE_ENV === 'development';

  // If it's already an APIError, use it directly
  if (error instanceof APIError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      ...(isDevelopment && error.details && { details: error.details }),
      timestamp: error.timestamp,
    });
  }

  // Handle Supabase errors
  if (error.message && error.message.includes('duplicate key')) {
    return res.status(409).json({
      error: 'Cette ressource existe déjà',
      code: 'DUPLICATE_RESOURCE',
      timestamp: new Date().toISOString(),
    });
  }

  if (error.message && error.message.includes('foreign key')) {
    return res.status(400).json({
      error: 'Référence invalide vers une autre ressource',
      code: 'INVALID_REFERENCE',
      timestamp: new Date().toISOString(),
    });
  }

  if (error.message && error.message.includes('violates check constraint')) {
    return res.status(400).json({
      error: 'Les données ne respectent pas les contraintes de la base de données',
      code: 'CONSTRAINT_VIOLATION',
      ...(isDevelopment && { details: error.message }),
      timestamp: new Date().toISOString(),
    });
  }

  // Handle network/connection errors
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    return res.status(503).json({
      error: 'La base de données est actuellement indisponible',
      code: 'DATABASE_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
  }

  // Handle validation/parsing errors
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return res.status(400).json({
      error: 'Format de données invalide',
      code: 'INVALID_DATA_FORMAT',
      ...(isDevelopment && { details: error.message }),
      timestamp: new Date().toISOString(),
    });
  }

  // Generic database error
  if (error.message && (error.message.includes('database') || error.message.includes('query'))) {
    return res.status(500).json({
      error: 'Erreur lors de l\'accès à la base de données',
      code: 'DATABASE_ERROR',
      ...(isDevelopment && { details: error.message }),
      timestamp: new Date().toISOString(),
    });
  }

  // Default internal server error
  return res.status(500).json({
    error: 'Une erreur interne s\'est produite',
    code: 'INTERNAL_SERVER_ERROR',
    ...(isDevelopment && { details: error.message, stack: error.stack }),
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  APIError,
  handleError,
};
