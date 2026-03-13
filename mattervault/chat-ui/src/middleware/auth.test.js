/**
 * Route-level integration tests for auth middleware
 *
 * Tests requireAuth, optionalAuth, and requireAdmin middleware
 * using supertest with a minimal Express app.
 */

const express = require('express');
const request = require('supertest');

// Mock the auth module (../auth from the middleware's perspective)
jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

const { verifyAccessToken } = require('../auth');
const { requireAuth, optionalAuth, requireAdmin } = require('./auth');

/**
 * Create a tiny Express app that mounts the given middlewares
 * on GET /test, returning { user: req.user || null }.
 */
function appWith(...middlewares) {
  const app = express();
  app.get('/test', ...middlewares, (req, res) => {
    res.json({ user: req.user || null });
  });
  return app;
}

// Decoded token payload returned by verifyAccessToken when valid
const VALID_DECODED = {
  userId: 'uuid-123',
  paperlessUserId: 3,
  paperlessUsername: 'jsmith',
  role: 'user',
  displayName: 'John Smith',
};

describe('requireAuth', () => {
  let app;

  beforeEach(() => {
    app = appWith(requireAuth);
    jest.resetAllMocks();
  });

  test('rejects request without Authorization header (401, NO_TOKEN)', async () => {
    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_TOKEN');
  });

  test('rejects request with invalid token (401, INVALID_TOKEN)', async () => {
    verifyAccessToken.mockReturnValue(null);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer bad-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('passes and populates req.user with valid token', async () => {
    verifyAccessToken.mockReturnValue(VALID_DECODED);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: 'uuid-123',
      paperlessUserId: 3,
      paperlessUsername: 'jsmith',
      role: 'user',
      displayName: 'John Smith',
    });
  });
});

describe('optionalAuth', () => {
  let app;

  beforeEach(() => {
    app = appWith(optionalAuth);
    jest.resetAllMocks();
  });

  test('passes without token, user is null', async () => {
    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  test('populates user when valid token provided', async () => {
    verifyAccessToken.mockReturnValue(VALID_DECODED);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: 'uuid-123',
      paperlessUserId: 3,
      paperlessUsername: 'jsmith',
      role: 'user',
      displayName: 'John Smith',
    });
  });

  test('passes without error when token is invalid, user is null', async () => {
    verifyAccessToken.mockReturnValue(null);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer bad-token');

    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

describe('requireAdmin', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('rejects when req.user is missing (401)', async () => {
    // Mount requireAdmin alone (no requireAuth before it)
    const app = appWith(requireAdmin);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_TOKEN');
  });

  test('rejects non-admin user (403, FORBIDDEN)', async () => {
    verifyAccessToken.mockReturnValue(VALID_DECODED);
    const app = appWith(requireAuth, requireAdmin);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('passes admin user', async () => {
    verifyAccessToken.mockReturnValue({ ...VALID_DECODED, role: 'admin' });
    const app = appWith(requireAuth, requireAdmin);

    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer admin-token');

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
  });
});
