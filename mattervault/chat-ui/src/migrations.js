/**
 * Database migrations runner
 * Runs SQL migrations on startup
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

/**
 * Run all pending migrations
 * Creates a migrations tracking table if it doesn't exist
 */
async function runMigrations() {
  console.log('Running database migrations...');

  // Create migrations tracking table
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Get list of already executed migrations
  const { rows: executed } = await db.query('SELECT filename FROM _migrations');
  const executedSet = new Set(executed.map(r => r.filename));

  // Read migration files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let migrationsRun = 0;

  for (const filename of files) {
    if (executedSet.has(filename)) {
      console.log(`  - ${filename}: already executed`);
      continue;
    }

    console.log(`  - ${filename}: executing...`);

    const filepath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filepath, 'utf8');

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (filename) VALUES ($1)',
        [filename]
      );
      await client.query('COMMIT');
      migrationsRun++;
      console.log(`  - ${filename}: success`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  - ${filename}: FAILED - ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`Migrations complete. ${migrationsRun} new migration(s) executed.`);
}

/**
 * Wait for database to be ready before running migrations
 * Retries with exponential backoff
 */
async function waitForDatabase(maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const healthy = await db.healthCheck();
      if (healthy) {
        console.log('Database connection established.');
        return true;
      }
    } catch (err) {
      // Ignore connection errors during startup
    }

    const delay = Math.min(1000 * Math.pow(2, i), 30000);
    console.log(`Waiting for database... retry ${i + 1}/${maxRetries} (${delay}ms)`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw new Error('Could not connect to database after maximum retries');
}

module.exports = {
  runMigrations,
  waitForDatabase
};
