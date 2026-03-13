/**
 * Shared test utilities for route integration tests.
 *
 * Provides:
 *  - Standard mock user objects (admin + regular)
 *  - createApp(router, path, opts) — mount a router on a throwaway Express app
 */

const express = require('express');

// --- Mock user fixtures ---------------------------------------------------

const TEST_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  paperlessUserId: 1,
  paperlessUsername: 'testuser',
  role: 'user',
  displayName: 'Test User',
};

const TEST_ADMIN = {
  id: '22222222-2222-2222-2222-222222222222',
  paperlessUserId: 2,
  paperlessUsername: 'admin',
  role: 'admin',
  displayName: 'Admin User',
};

const TEST_USER_DB_ROW = {
  id: TEST_USER.id,
  paperless_user_id: TEST_USER.paperlessUserId,
  paperless_username: TEST_USER.paperlessUsername,
  paperless_token: 'paperless_token_123',
  display_name: TEST_USER.displayName,
  role: TEST_USER.role,
  created_at: new Date().toISOString(),
  last_synced_at: new Date().toISOString(),
};

const TEST_ADMIN_DB_ROW = {
  id: TEST_ADMIN.id,
  paperless_user_id: TEST_ADMIN.paperlessUserId,
  paperless_username: TEST_ADMIN.paperlessUsername,
  paperless_token: 'paperless_token_456',
  display_name: TEST_ADMIN.displayName,
  role: TEST_ADMIN.role,
  created_at: new Date().toISOString(),
  last_synced_at: new Date().toISOString(),
};

// --- App factory ----------------------------------------------------------

/**
 * Build a minimal Express app with a router mounted at `mountPath`.
 *
 * Options:
 *   auth  – 'user' | 'admin' | 'none'  (default 'user')
 *           Injects a fake requireAuth that sets req.user.
 */
function createApp(router, mountPath, opts = {}) {
  const app = express();
  app.use(express.json());

  const authLevel = opts.auth ?? 'user';

  if (authLevel !== 'none') {
    const user = authLevel === 'admin' ? TEST_ADMIN : TEST_USER;
    app.use((req, _res, next) => {
      req.user = { ...user };
      next();
    });
  }

  app.use(mountPath, router);
  return app;
}

module.exports = {
  TEST_USER,
  TEST_ADMIN,
  TEST_USER_DB_ROW,
  TEST_ADMIN_DB_ROW,
  createApp,
};
