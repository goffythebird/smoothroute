/**
 * SmoothRoute — Express Authentication Middleware
 */

const { verifyJwt, parseCookies } = require('../utils/auth');

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sr_token) {
    return cookies.sr_token;
  }
  return null;
}

function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (token) {
    const decoded = verifyJwt(token);
    if (decoded && decoded.userId) {
      req.user = decoded;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in or create an account.'
    });
  }
  const decoded = verifyJwt(token);
  if (!decoded || !decoded.userId) {
    return res.status(401).json({
      error: 'Invalid or expired authentication session. Please log in again.'
    });
  }
  req.user = decoded;
  next();
}

module.exports = {
  extractToken,
  optionalAuth,
  requireAuth
};
