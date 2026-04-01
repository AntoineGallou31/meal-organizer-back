function validateUUID(paramName) {
  return (req, res, next) => {
    const val = req.params[paramName];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(val)) {
      return res.status(400).json({ error: `${paramName} invalide` });
    }
    return next();
  };
}

module.exports = validateUUID;
