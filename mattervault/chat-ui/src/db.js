/**
 * Database connection pool for PostgreSQL
 * Uses environment variables for configuration
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.CHATUI_DB_HOST || 'matterdb-chatui',
  port: parseInt(process.env.CHATUI_DB_PORT || '5432'),
  database: process.env.CHATUI_DB_NAME || 'chatui',
  user: process.env.CHATUI_DB_USER || 'chatui',
  password: process.env.CHATUI_DB_PASS || 'chatui_secure_pass',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

/**
 * Execute a parameterized query
 * @param {string} text - SQL query with $1, $2, etc. placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn('Slow query:', { text, duration, rows: result.rowCount });
    }
    return result;
  } catch (err) {
    console.error('Query error:', { text, error: err.message });
    throw err;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

/**
 * Check database connectivity
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('Database health check failed:', err.message);
    return false;
  }
}

module.exports = {
  query,
  getClient,
  healthCheck,
  pool
};
