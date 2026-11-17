/**
 * SmoothRoute — Cryptographic Authentication & Token Utilities
 * Uses Node.js built-in crypto (scrypt + HMAC-SHA256 JWT) with private .env credentials.
 */

const crypto = require('node:crypto');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'replace_with_64_byte_random_hex_secret_do_not_commit') {
    throw new Error('JWT_SECRET is missing or set to placeholder. Ensure private .env is configured.');
  }
  return secret;
}

/**
 * Hash a plaintext password using scrypt with a random 16-byte salt.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

/**
 * Verify a plaintext password against a stored salt:hash string using constant-time comparison.
 */
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuffer = Buffer.from(keyHex, 'hex');
  const derivedBuffer = crypto.scryptSync(String(password), salt, 64);
  if (keyBuffer.length !== derivedBuffer.length) return false;
  return crypto.timingSafeEqual(keyBuffer, derivedBuffer);
}

/**
 * Sign a JWT token using HMAC-SHA256 and the private JWT_SECRET.
 */
function signJwt(payload, expiresInHours = Number(process.env.JWT_EXPIRES_IN_HOURS || 168)) {
  const secret = getJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: nowSec,
    exp: nowSec + Math.floor(expiresInHours * 3600)
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

/**
 * Verify and decode a JWT token. Returns decoded payload or null if invalid/expired.
 */
function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const secret = getJwtSecret();
    const [encodedHeader, encodedPayload, signature] = parts;
    const data = `${encodedHeader}.${encodedPayload}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Parse cookies from Cookie header string.
 */
function parseCookies(cookieHeader = '') {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  });
  return cookies;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  parseCookies
};
