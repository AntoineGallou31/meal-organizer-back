const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function blockWritesInDemo(req, res, next) {
  if (process.env.DEMO_MODE === 'true' && WRITE_METHODS.has(req.method)) {
    return res.status(403).json({
      error: 'Cette action est désactivée sur la démo publique',
      code: 'DEMO_READ_ONLY',
    });
  }
  return next();
}

module.exports = blockWritesInDemo;
