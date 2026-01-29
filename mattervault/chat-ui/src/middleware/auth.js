/**
 * Authentication middleware
 * Protects routes, validates JWT tokens
 */

const auth = require('../auth');

/**
 * Middleware to require authentication
 * Validates the Authorization header (Bearer token)
 * Attaches user info to req.user if valid
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'NO_TOKEN'
    });
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix
  const decoded = auth.verifyAccessToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN'
    });
  }

  // Attach user info to request (Paperless-based auth)
  req.user = {
    id: decoded.userId,
    paperlessUserId: decoded.paperlessUserId,
    paperlessUsername: decoded.paperlessUsername,
    role: decoded.role,
    displayName: decoded.displayName
  };

  next();
}

/**
 * Middleware for optional authentication
 * If a valid token is provided, attaches user info
 * If no token or invalid token, continues without error
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = auth.verifyAccessToken(token);

    if (decoded) {
      req.user = {
        id: decoded.userId,
        paperlessUserId: decoded.paperlessUserId,
        paperlessUsername: decoded.paperlessUsername,
        role: decoded.role,
        displayName: decoded.displayName
      };
    }
  }

  next();
}

/**
 * Middleware to require admin role
 * Must be used after requireAuth
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'NO_TOKEN'
    });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required',
      code: 'FORBIDDEN'
    });
  }

  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin
};
