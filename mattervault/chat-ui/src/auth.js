/**
 * Authentication utilities
 * JWT generation, password hashing, token management
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Redis = require('ioredis');
const db = require('./db');

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_in_production';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;
const BCRYPT_ROUNDS = 12;

// Redis client for session caching (uses database 1 to avoid Paperless collisions)
const redis = new Redis(process.env.REDIS_URL || 'redis://mattercache:6379/1');

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('Redis connected for session caching');
});

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify a password against a hash
 * @param {string} password - Plain text password
 * @param {string} hash - Stored hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generate an access token (JWT)
 * @param {Object} user - User object with id, email, family_id, role
 * @returns {string} JWT access token
 */
function generateAccessToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      familyId: user.family_id,
      role: user.role,
      displayName: user.display_name
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Verify and decode an access token
 * @param {string} token - JWT access token
 * @returns {Object|null} Decoded payload or null if invalid
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

/**
 * Generate a refresh token (random string)
 * @returns {string} Random refresh token
 */
function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

/**
 * Hash a refresh token for storage
 * @param {string} token - Raw refresh token
 * @returns {string} SHA-256 hash
 */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new session in the database
 * @param {string} userId - User UUID
 * @param {string} refreshToken - Raw refresh token (will be hashed)
 * @returns {Promise<string>} Session ID
 */
async function createSession(userId, refreshToken) {
  const sessionId = crypto.randomUUID();
  const tokenHash = hashRefreshToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, userId, tokenHash, expiresAt]
  );

  // Cache in Redis (expires slightly before DB record)
  const cacheExpiry = REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 - 60;
  await redis.setex(
    `session:${sessionId}`,
    cacheExpiry,
    JSON.stringify({ userId, tokenHash, expiresAt: expiresAt.toISOString() })
  );

  return sessionId;
}

/**
 * Validate a refresh token and return the session
 * @param {string} sessionId - Session UUID
 * @param {string} refreshToken - Raw refresh token
 * @returns {Promise<Object|null>} Session data or null if invalid
 */
async function validateRefreshToken(sessionId, refreshToken) {
  const tokenHash = hashRefreshToken(refreshToken);

  // Try cache first
  const cached = await redis.get(`session:${sessionId}`);
  if (cached) {
    const session = JSON.parse(cached);
    if (session.tokenHash === tokenHash && new Date(session.expiresAt) > new Date()) {
      return session;
    }
  }

  // Fallback to database
  const { rows } = await db.query(
    `SELECT user_id, refresh_token_hash, expires_at
     FROM sessions
     WHERE id = $1 AND expires_at > NOW()`,
    [sessionId]
  );

  if (rows.length === 0) return null;

  const session = rows[0];
  if (session.refresh_token_hash !== tokenHash) return null;

  // Update cache
  await redis.setex(
    `session:${sessionId}`,
    Math.floor((new Date(session.expires_at) - new Date()) / 1000),
    JSON.stringify({
      userId: session.user_id,
      tokenHash: session.refresh_token_hash,
      expiresAt: session.expires_at.toISOString()
    })
  );

  return { userId: session.user_id };
}

/**
 * Invalidate a session (logout)
 * @param {string} sessionId - Session UUID
 */
async function invalidateSession(sessionId) {
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  await redis.del(`session:${sessionId}`);
}

/**
 * Invalidate all sessions for a user
 * @param {string} userId - User UUID
 */
async function invalidateAllUserSessions(userId) {
  // Get all session IDs for user
  const { rows } = await db.query(
    'SELECT id FROM sessions WHERE user_id = $1',
    [userId]
  );

  // Delete from database
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

  // Delete from cache
  for (const row of rows) {
    await redis.del(`session:${row.id}`);
  }
}

/**
 * Clean up expired sessions (can be run periodically)
 */
async function cleanupExpiredSessions() {
  const { rowCount } = await db.query(
    'DELETE FROM sessions WHERE expires_at < NOW()'
  );
  if (rowCount > 0) {
    console.log(`Cleaned up ${rowCount} expired sessions`);
  }
}

/**
 * Get user by ID
 * @param {string} userId - User UUID
 * @returns {Promise<Object|null>}
 */
async function getUserById(userId) {
  const { rows } = await db.query(
    `SELECT id, email, family_id, display_name, role, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * Get user by email
 * @param {string} email - User email
 * @returns {Promise<Object|null>} User with password_hash included
 */
async function getUserByEmail(email) {
  const { rows } = await db.query(
    `SELECT id, email, password_hash, family_id, display_name, role, created_at
     FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  return rows[0] || null;
}

/**
 * Create a new user
 * @param {Object} userData - User data
 * @returns {Promise<Object>} Created user (without password_hash)
 */
async function createUser({ email, password, familyId, displayName }) {
  const passwordHash = await hashPassword(password);

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, family_id, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, family_id, display_name, role, created_at`,
    [email.toLowerCase(), passwordHash, familyId, displayName || null]
  );

  return rows[0];
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  createSession,
  validateRefreshToken,
  invalidateSession,
  invalidateAllUserSessions,
  cleanupExpiredSessions,
  getUserById,
  getUserByEmail,
  createUser,
  redis
};
