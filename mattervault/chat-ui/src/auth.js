/**
 * Authentication utilities
 * Paperless-ngx authentication, JWT generation, token management
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Redis = require('ioredis');
const db = require('./db');

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_in_production';
const ACCESS_TOKEN_EXPIRY = '24h';           // Default session length
const REMEMBER_ME_EXPIRY = '30d';            // Extended session when "remember me" checked
const REFRESH_TOKEN_EXPIRY_DAYS = 30;        // Refresh token valid for 30 days
const PAPERLESS_URL = process.env.PAPERLESS_URL || 'http://mattervault:8000';

// System tags to exclude when fetching families
const SYSTEM_TAGS = ['inbox', 'intake', 'processed', 'processing', 'error', 'pending', 'ai_ready', 'ingestion_error'];

// Redis client for session caching (uses database 1 to avoid Paperless collisions)
const redis = new Redis(process.env.REDIS_URL || 'redis://mattercache:6379/1');

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('Redis connected for session caching');
});

/**
 * Verify credentials against Paperless-ngx API
 * @param {string} username - Paperless username
 * @param {string} password - Paperless password
 * @returns {Promise<Object|null>} Token response or null if invalid
 */
async function verifyPaperlessCredentials(username, password) {
  try {
    const response = await fetch(`${PAPERLESS_URL}/api/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) {
      console.log(`Paperless auth failed for ${username}: ${response.status}`);
      return null;
    }

    return response.json();
  } catch (err) {
    console.error('Paperless authentication error:', err.message);
    return null;
  }
}

/**
 * Fetch user information from Paperless
 * @param {string} token - Paperless API token
 * @returns {Promise<Object|null>} User info or null
 */
async function fetchPaperlessUser(token) {
  try {
    // Paperless-ngx doesn't have a dedicated /me endpoint, but we can get user info
    // from the users API if we have permission, otherwise we just return basic info
    const response = await fetch(`${PAPERLESS_URL}/api/ui_settings/`, {
      headers: { 'Authorization': `Token ${token}` }
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      id: data.user?.id,
      username: data.user?.username,
      displayName: data.display_name || data.user?.username,
      isSuperuser: data.user?.is_superuser || false
    };
  } catch (err) {
    console.error('Error fetching Paperless user:', err.message);
    return null;
  }
}

/**
 * Fetch all family tags from Paperless
 * @param {string} token - Paperless API token
 * @returns {Promise<Array>} Array of family tags with document counts
 */
async function fetchUserFamilies(token) {
  const QDRANT_URL = process.env.QDRANT_URL || 'http://mattermemory:6333';
  const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'mattervault_documents';

  try {
    // Query Qdrant for actual family_id values — this is the source of truth
    const qdrantRes = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10000, with_payload: ['family_id'], with_vector: false })
    });

    if (!qdrantRes.ok) {
      console.error('Failed to fetch Qdrant families:', qdrantRes.status);
      return [];
    }

    const qdrantData = await qdrantRes.json();
    const points = qdrantData.result?.points || [];

    // Count documents per family_id
    const familyCounts = {};
    const docsByFamily = {};
    for (const p of points) {
      const fid = p.payload?.family_id;
      if (!fid) continue;
      if (!docsByFamily[fid]) docsByFamily[fid] = new Set();
      docsByFamily[fid].add(p.payload?.document_id);
      familyCounts[fid] = (familyCounts[fid] || 0) + 1;
    }

    return Object.keys(docsByFamily).sort().map(fid => ({
      id: fid,
      name: fid,
      slug: fid,
      document_count: docsByFamily[fid].size
    }));
  } catch (err) {
    console.error('Error fetching families:', err.message);
    return [];
  }
}

/**
 * Sync/create user from Paperless authentication
 * @param {Object} paperlessUser - User info from Paperless
 * @param {string} paperlessToken - Paperless API token
 * @returns {Promise<Object>} Local user record
 */
async function syncUserFromPaperless(paperlessUser, paperlessToken) {
  // Check if user already exists by Paperless user ID
  const { rows: existingUsers } = await db.query(
    `SELECT id, paperless_user_id, paperless_username, display_name, role, created_at
     FROM users WHERE paperless_user_id = $1`,
    [paperlessUser.id]
  );

  if (existingUsers.length > 0) {
    // Update existing user with new token, sync time, AND role from Paperless
    // This ensures admin status is always synced from Paperless on login
    const role = paperlessUser.isSuperuser ? 'admin' : 'user';
    const { rows } = await db.query(
      `UPDATE users
       SET paperless_token = $1,
           paperless_username = $2,
           display_name = COALESCE($3, display_name),
           role = $4,
           last_synced_at = NOW()
       WHERE paperless_user_id = $5
       RETURNING id, paperless_user_id, paperless_username, display_name, role, created_at`,
      [paperlessToken, paperlessUser.username, paperlessUser.displayName, role, paperlessUser.id]
    );
    return rows[0];
  }

  // Create new user
  const role = paperlessUser.isSuperuser ? 'admin' : 'user';
  const { rows } = await db.query(
    `INSERT INTO users (paperless_user_id, paperless_username, paperless_token, display_name, role, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, paperless_user_id, paperless_username, display_name, role, created_at`,
    [paperlessUser.id, paperlessUser.username, paperlessToken, paperlessUser.displayName, role]
  );

  return rows[0];
}

/**
 * Generate an access token (JWT)
 * @param {Object} user - User object with id, paperless_username, role
 * @param {boolean} rememberMe - If true, extend expiry to 30 days
 * @returns {string} JWT access token
 */
function generateAccessToken(user, rememberMe = false) {
  return jwt.sign(
    {
      userId: user.id,
      paperlessUserId: user.paperless_user_id,
      paperlessUsername: user.paperless_username,
      role: user.role,
      displayName: user.display_name
    },
    JWT_SECRET,
    { expiresIn: rememberMe ? REMEMBER_ME_EXPIRY : ACCESS_TOKEN_EXPIRY }
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
    `SELECT id, paperless_user_id, paperless_username, paperless_token, display_name, role, created_at, last_synced_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * Get user by Paperless username
 * @param {string} username - Paperless username
 * @returns {Promise<Object|null>}
 */
async function getUserByPaperlessUsername(username) {
  const { rows } = await db.query(
    `SELECT id, paperless_user_id, paperless_username, paperless_token, display_name, role, created_at, last_synced_at
     FROM users WHERE paperless_username = $1`,
    [username.toLowerCase()]
  );
  return rows[0] || null;
}

module.exports = {
  verifyPaperlessCredentials,
  fetchPaperlessUser,
  fetchUserFamilies,
  syncUserFromPaperless,
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  createSession,
  validateRefreshToken,
  invalidateSession,
  invalidateAllUserSessions,
  cleanupExpiredSessions,
  getUserById,
  getUserByPaperlessUsername,
  redis
};
