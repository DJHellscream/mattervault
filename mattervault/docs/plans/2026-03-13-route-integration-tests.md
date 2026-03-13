# Route-Level Integration Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add supertest-based route integration tests for chat-ui to catch regressions in auth middleware, route validation, error handling, and access control — without needing Docker or a running database.

**Architecture:** Each route file gets a co-located test file. A shared test helper creates a minimal Express app with the route mounted and mock dependencies injected via Jest module mocks. Tests exercise HTTP request/response behavior through supertest (in-process, no port binding). We mock `db`, `auth`, and `redis` — never external services.

**Tech Stack:** Jest 29 (existing), supertest (new devDependency)

---

### Task 1: Install supertest and create shared test helper

**Files:**
- Modify: `chat-ui/package.json` (add supertest devDependency)
- Create: `chat-ui/src/test-helpers.js`

**Step 1: Install supertest**

Run: `cd /workspace/mattervault/chat-ui && npm install --save-dev supertest`
Expected: supertest added to devDependencies in package.json

**Step 2: Create the shared test helper**

Create `chat-ui/src/test-helpers.js`:

```js
/**
 * Shared test utilities for route integration tests.
 *
 * Provides:
 *  - Standard mock user objects (admin + regular)
 *  - createApp(router, path, opts) — mount a router on a throwaway Express app
 *  - mockDb / mockAuth factories used by jest.mock() calls in test files
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
```

**Step 3: Verify tests still pass**

Run: `cd /workspace/mattervault/chat-ui && npm test`
Expected: 3 existing tests pass

**Step 4: Commit**

```
feat(tests): add supertest and shared test helper for route integration tests
```

---

### Task 2: Auth middleware tests

**Files:**
- Create: `chat-ui/src/middleware/auth.test.js`

**What to test:**
- `requireAuth`: rejects missing token (401), rejects invalid token (401), passes valid token and populates `req.user`
- `requireAdmin`: rejects non-admin (403), passes admin, rejects unauthenticated (401)
- `optionalAuth`: passes without token (no error), populates user with valid token, passes with invalid token (no error, no user)

**Step 1: Write the tests**

Create `chat-ui/src/middleware/auth.test.js`:

```js
const express = require('express');
const request = require('supertest');

// Mock the auth module
jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

const auth = require('../auth');
const { requireAuth, optionalAuth, requireAdmin } = require('./auth');

/** Helper: tiny Express app with one GET route behind the given middleware */
function appWith(...middlewares) {
  const app = express();
  app.get(
    '/test',
    ...middlewares,
    (req, res) => res.json({ user: req.user || null }),
  );
  return app;
}

describe('requireAuth', () => {
  afterEach(() => jest.resetAllMocks());

  test('rejects request without Authorization header', async () => {
    const res = await request(appWith(requireAuth)).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_TOKEN');
  });

  test('rejects request with invalid token', async () => {
    auth.verifyAccessToken.mockReturnValue(null);
    const res = await request(appWith(requireAuth))
      .get('/test')
      .set('Authorization', 'Bearer bad_token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('passes and populates req.user with valid token', async () => {
    auth.verifyAccessToken.mockReturnValue({
      userId: 'u1',
      paperlessUserId: 1,
      paperlessUsername: 'alice',
      role: 'user',
      displayName: 'Alice',
    });
    const res = await request(appWith(requireAuth))
      .get('/test')
      .set('Authorization', 'Bearer good_token');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('u1');
    expect(res.body.user.paperlessUsername).toBe('alice');
  });
});

describe('optionalAuth', () => {
  afterEach(() => jest.resetAllMocks());

  test('passes without token, user is null', async () => {
    const res = await request(appWith(optionalAuth)).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  test('populates user when valid token provided', async () => {
    auth.verifyAccessToken.mockReturnValue({
      userId: 'u2',
      paperlessUserId: 2,
      paperlessUsername: 'bob',
      role: 'admin',
      displayName: 'Bob',
    });
    const res = await request(appWith(optionalAuth))
      .get('/test')
      .set('Authorization', 'Bearer valid');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('u2');
  });

  test('passes without error when token is invalid', async () => {
    auth.verifyAccessToken.mockReturnValue(null);
    const res = await request(appWith(optionalAuth))
      .get('/test')
      .set('Authorization', 'Bearer invalid');
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

describe('requireAdmin', () => {
  afterEach(() => jest.resetAllMocks());

  test('rejects when req.user is missing', async () => {
    const res = await request(appWith(requireAdmin)).get('/test');
    expect(res.status).toBe(401);
  });

  test('rejects non-admin user', async () => {
    const setUser = (req, _res, next) => {
      req.user = { role: 'user' };
      next();
    };
    const res = await request(appWith(setUser, requireAdmin)).get('/test');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('passes admin user', async () => {
    const setUser = (req, _res, next) => {
      req.user = { role: 'admin' };
      next();
    };
    const res = await request(appWith(setUser, requireAdmin)).get('/test');
    expect(res.status).toBe(200);
  });
});
```

**Step 2: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npx jest src/middleware/auth.test.js --verbose`
Expected: All 8 tests pass

**Step 3: Commit**

```
test(middleware): add requireAuth, optionalAuth, requireAdmin integration tests
```

---

### Task 3: Conversations route tests

**Files:**
- Create: `chat-ui/src/routes/conversations.test.js`

**What to test:**
- `GET /` — returns paginated list, filters by family_id
- `POST /` — creates conversation, validates family_id required
- `GET /:id` — returns conversation with messages, 404 for wrong user
- `PATCH /:id` — updates title, 404 for wrong user
- `DELETE /:id` — deletes, 404 for wrong user
- User isolation: user A cannot see user B's conversations

**Step 1: Write the tests**

Create `chat-ui/src/routes/conversations.test.js`:

```js
const request = require('supertest');
const { createApp, TEST_USER } = require('../test-helpers');

jest.mock('../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const db = require('../db');
const router = require('./conversations');

const app = createApp(router, '/api/conversations');

describe('GET /api/conversations', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns paginated conversation list', async () => {
    const mockConv = {
      id: 'conv-1',
      family_id: 'morrison',
      title: 'Test',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      message_count: '3',
    };
    db.query
      .mockResolvedValueOnce({ rows: [mockConv] })          // conversations query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });   // count query

    const res = await request(app).get('/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].familyId).toBe('morrison');
    expect(res.body.pagination.total).toBe(1);
  });

  test('filters by family_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/api/conversations?family_id=johnson');
    expect(res.status).toBe(200);
    // Verify family_id was passed as a parameter
    expect(db.query.mock.calls[0][1]).toContain('johnson');
  });

  test('clamps limit to 100', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/api/conversations?limit=500');
    // The limit param should be clamped to 100
    const params = db.query.mock.calls[0][1];
    expect(params).toContain(100);
  });
});

describe('POST /api/conversations', () => {
  afterEach(() => jest.resetAllMocks());

  test('creates conversation with family_id', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'new-conv',
        family_id: 'morrison',
        title: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });

    const res = await request(app)
      .post('/api/conversations')
      .send({ family_id: 'morrison' });
    expect(res.status).toBe(201);
    expect(res.body.familyId).toBe('morrison');
  });

  test('rejects missing family_id', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/conversations/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns conversation with messages', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'conv-1',
          family_id: 'morrison',
          title: 'Test',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          citations: null,
          created_at: new Date().toISOString(),
        }],
      });

    const res = await request(app).get('/api/conversations/conv-1');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].role).toBe('user');
  });

  test('returns 404 when conversation not found (user isolation)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/conversations/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/conversations/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('updates title', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'conv-1',
        family_id: 'morrison',
        title: 'New Title',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .send({ title: 'New Title' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New Title');
  });

  test('rejects missing title', async () => {
    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 for other user\'s conversation', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .send({ title: 'Stolen' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/conversations/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('deletes conversation', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).delete('/api/conversations/conv-1');
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
  });

  test('returns 404 for other user\'s conversation', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app).delete('/api/conversations/other-conv');
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npx jest src/routes/conversations.test.js --verbose`
Expected: All 10 tests pass

**Step 3: Commit**

```
test(conversations): add route integration tests for CRUD + user isolation
```

---

### Task 4: Prompts route tests

**Files:**
- Create: `chat-ui/src/routes/prompts.test.js`

**What to test:**
- `GET /` — regular user sees enabled only, admin sees all
- `POST /` — admin can create, validates required fields, non-admin gets 403
- `PUT /:id` — admin can update, validates UUID, 404 for missing
- `DELETE /:id` — blocks default prompt deletion, 404 for missing, non-admin gets 403
- `PATCH /reorder` — validates order array, uses transaction (client.query not pool.query)

**Step 1: Write the tests**

Create `chat-ui/src/routes/prompts.test.js`:

```js
const request = require('supertest');
const { createApp, TEST_USER, TEST_ADMIN } = require('../test-helpers');

// Mock auth module (needed by middleware/auth)
jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const db = require('../db');
const router = require('./prompts');

const adminApp = createApp(router, '/api/prompts', { auth: 'admin' });
const userApp = createApp(router, '/api/prompts', { auth: 'user' });

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('GET /api/prompts', () => {
  afterEach(() => jest.resetAllMocks());

  test('regular user sees only enabled prompts', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: VALID_UUID, title: 'Prompt 1', enabled: true }],
    });

    const res = await request(userApp).get('/api/prompts');
    expect(res.status).toBe(200);
    // Verify the query includes "WHERE enabled = true"
    expect(db.query.mock.calls[0][0]).toMatch(/enabled = true/);
  });

  test('admin sees all prompts', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp).get('/api/prompts');
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][0]).not.toMatch(/enabled = true/);
  });
});

describe('POST /api/prompts', () => {
  afterEach(() => jest.resetAllMocks());

  test('admin can create a prompt', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ next_order: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: VALID_UUID, title: 'New' }] });

    const res = await request(adminApp)
      .post('/api/prompts')
      .send({ title: 'New', prompt_text: 'Do something' });
    expect(res.status).toBe(201);
    expect(res.body.prompt.title).toBe('New');
  });

  test('rejects missing required fields', async () => {
    const res = await request(adminApp)
      .post('/api/prompts')
      .send({ title: 'No text' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp)
      .post('/api/prompts')
      .send({ title: 'X', prompt_text: 'Y' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/prompts/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('admin can update a prompt', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: VALID_UUID, title: 'Updated' }],
    });

    const res = await request(adminApp)
      .put(`/api/prompts/${VALID_UUID}`)
      .send({ title: 'Updated', prompt_text: 'New text' });
    expect(res.status).toBe(200);
  });

  test('rejects invalid UUID', async () => {
    const res = await request(adminApp)
      .put('/api/prompts/not-a-uuid')
      .send({ title: 'X', prompt_text: 'Y' });
    expect(res.status).toBe(400);
  });

  test('returns 404 for missing prompt', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp)
      .put(`/api/prompts/${VALID_UUID}`)
      .send({ title: 'X', prompt_text: 'Y' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/prompts/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('blocks deletion of default prompts', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_default: true }] });

    const res = await request(adminApp).delete(`/api/prompts/${VALID_UUID}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/default/i);
  });

  test('deletes non-default prompt', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ is_default: false }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(adminApp).delete(`/api/prompts/${VALID_UUID}`);
    expect(res.status).toBe(200);
  });

  test('returns 404 for missing prompt', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp).delete(`/api/prompts/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp).delete(`/api/prompts/${VALID_UUID}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/prompts/reorder', () => {
  afterEach(() => jest.resetAllMocks());

  test('reorders with proper transaction on dedicated client', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(mockClient);

    const order = [
      { id: VALID_UUID, sort_order: 0 },
      { id: '00000000-0000-0000-0000-000000000002', sort_order: 1 },
    ];

    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order });
    expect(res.status).toBe(200);

    // Verify transaction used the dedicated client, not pool
    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
    // Verify db.query was NOT used for the transaction
    expect(db.query).not.toHaveBeenCalled();
  });

  test('rejects empty order array', async () => {
    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order: [] });
    expect(res.status).toBe(400);
  });

  test('rejects invalid UUID in order', async () => {
    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order: [{ id: 'bad', sort_order: 0 }] });
    expect(res.status).toBe(400);
  });

  test('rolls back on error and releases client', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({})          // BEGIN
        .mockRejectedValueOnce(new Error('DB error')), // first UPDATE
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(mockClient);

    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order: [{ id: VALID_UUID, sort_order: 0 }] });
    expect(res.status).toBe(500);

    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npx jest src/routes/prompts.test.js --verbose`
Expected: All 13 tests pass

**Step 3: Commit**

```
test(prompts): add route integration tests for CRUD, reorder transaction, and admin access control
```

---

### Task 5: Audit route tests

**Files:**
- Create: `chat-ui/src/routes/audit.test.js`

**What to test:**
- `GET /recent` — returns paginated logs, applies filters, admin-only (403 for users)
- `GET /export` — validates date range, rejects >1 year, streams JSONL, uses cursor
- `GET /summary` — groups by user/family/month, defaults to 30 days
- `GET /query/:correlationId` — validates UUID, returns 404 for missing

**Step 1: Write the tests**

Create `chat-ui/src/routes/audit.test.js`:

```js
const request = require('supertest');
const { createApp } = require('../test-helpers');

jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const db = require('../db');
const router = require('./audit');

const adminApp = createApp(router, '/api/audit', { auth: 'admin' });
const userApp = createApp(router, '/api/audit', { auth: 'user' });

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('GET /api/audit/recent', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns paginated logs for admin', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: '1', query_text: 'test', total: '1' }],
    });

    const res = await request(adminApp).get('/api/audit/recent');
    expect(res.status).toBe(200);
    expect(res.body.logs).toBeDefined();
    expect(res.body.pagination).toBeDefined();
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp).get('/api/audit/recent');
    expect(res.status).toBe(403);
  });

  test('clamps limit to 200', async () => {
    db.query.mockResolvedValue({ rows: [{ total: '0' }] });

    await request(adminApp).get('/api/audit/recent?limit=999');
    // Find the query with LIMIT parameter
    const mainQuery = db.query.mock.calls[0];
    expect(mainQuery[1]).toContain(200);
  });
});

describe('GET /api/audit/export', () => {
  afterEach(() => jest.resetAllMocks());

  test('rejects missing dates', async () => {
    const res = await request(adminApp).get('/api/audit/export');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('rejects invalid date format', async () => {
    const res = await request(adminApp)
      .get('/api/audit/export?start_date=nope&end_date=nope');
    expect(res.status).toBe(400);
  });

  test('rejects date range exceeding 1 year', async () => {
    const res = await request(adminApp)
      .get('/api/audit/export?start_date=2024-01-01&end_date=2026-01-01');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 year/);
  });

  test('streams JSONL using cursor on dedicated client', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce({})                                       // BEGIN
        .mockResolvedValueOnce({})                                       // DECLARE CURSOR
        .mockResolvedValueOnce({ rows: [{ id: '1', query_text: 'hi' }] }) // FETCH batch 1
        .mockResolvedValueOnce({ rows: [] })                             // FETCH batch 2 (empty)
        .mockResolvedValueOnce({})                                       // CLOSE
        .mockResolvedValueOnce({}),                                      // COMMIT
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(mockClient);

    const res = await request(adminApp)
      .get('/api/audit/export?start_date=2026-01-01&end_date=2026-02-01');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/ndjson/);

    // Verify cursor-based streaming was used
    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toMatch(/DECLARE.*CURSOR/);
    expect(calls[2]).toMatch(/FETCH/);
    expect(mockClient.release).toHaveBeenCalled();

    // Body should be JSONL
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe('1');
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp)
      .get('/api/audit/export?start_date=2026-01-01&end_date=2026-02-01');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/audit/summary', () => {
  afterEach(() => jest.resetAllMocks());

  test('defaults to month grouping', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp).get('/api/audit/summary');
    expect(res.status).toBe(200);
    expect(res.body.summary.group_by).toBe('month');
  });

  test('groups by user', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ paperless_username: 'alice', query_count: '5' }],
    });

    const res = await request(adminApp).get('/api/audit/summary?group_by=user');
    expect(res.status).toBe(200);
    expect(res.body.summary.group_by).toBe('user');
  });

  test('groups by family', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ family_id: 'morrison', query_count: '10' }],
    });

    const res = await request(adminApp).get('/api/audit/summary?group_by=family');
    expect(res.status).toBe(200);
    expect(res.body.data[0].family_id).toBe('morrison');
  });
});

describe('GET /api/audit/query/:correlationId', () => {
  afterEach(() => jest.resetAllMocks());

  test('rejects invalid UUID', async () => {
    const res = await request(adminApp).get('/api/audit/query/not-a-uuid');
    expect(res.status).toBe(400);
  });

  test('returns 404 for missing log', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp).get(`/api/audit/query/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });

  test('returns audit log by correlation ID', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ correlation_id: VALID_UUID, query_text: 'test' }],
    });

    const res = await request(adminApp).get(`/api/audit/query/${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.audit_log.correlation_id).toBe(VALID_UUID);
  });
});
```

**Step 2: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npx jest src/routes/audit.test.js --verbose`
Expected: All 14 tests pass

**Step 3: Commit**

```
test(audit): add route integration tests for recent, export cursor streaming, summary, and query lookup
```

---

### Task 6: Chat API route tests

**Files:**
- Create: `chat-ui/src/api.test.js`

**What to test:**
- `POST /api/chat` — validates family_id and question, creates conversation when none given, verifies ownership of existing conversation, forwards to n8n, saves messages
- `GET /api/health` — returns ok

**Step 1: Write the tests**

Create `chat-ui/src/api.test.js`:

```js
const request = require('supertest');
const { createApp, TEST_USER } = require('./test-helpers');

jest.mock('./db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const db = require('./db');
const { createApiRouter } = require('./api');

// Mock global fetch for n8n webhook calls
const originalFetch = global.fetch;

const config = {
  n8n: { webhookUrl: 'http://matterlogic:5678/webhook/chat-api' },
};

const router = createApiRouter(config);
const app = createApp(router, '/api');

afterAll(() => {
  global.fetch = originalFetch;
});

describe('POST /api/chat', () => {
  afterEach(() => {
    jest.resetAllMocks();
    global.fetch = originalFetch;
  });

  test('rejects missing family_id', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ question: 'Hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/family_id/);
  });

  test('rejects missing question', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ family_id: 'morrison' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question/);
  });

  test('creates new conversation when no conversation_id', async () => {
    // INSERT conversation
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'new-conv-id' }] })
      // INSERT user message
      .mockResolvedValueOnce({ rows: [] })
      // INSERT assistant message
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE conversation timestamp
      .mockResolvedValueOnce({ rows: [] });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ output: 'Answer', citations: [] }),
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ family_id: 'morrison', question: 'What is the trust?' });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe('new-conv-id');
  });

  test('verifies ownership of existing conversation', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // ownership check returns empty

    const res = await request(app)
      .post('/api/chat')
      .send({
        family_id: 'morrison',
        question: 'Hello',
        conversation_id: 'someone-elses-conv',
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/health', () => {
  test('returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
```

**Step 2: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npx jest src/api.test.js --verbose`
Expected: All 5 tests pass

**Step 3: Commit**

```
test(api): add route integration tests for chat endpoint validation and conversation ownership
```

---

### Task 7: Run full suite and final commit

**Step 1: Run all tests**

Run: `cd /workspace/mattervault/chat-ui && npm test`
Expected: All tests pass (~40+ tests across 6 files)

**Step 2: Verify no regressions**

Run: `cd /workspace/mattervault/chat-ui && npm test -- --verbose 2>&1 | tail -20`
Expected: All suites pass, no warnings

**Step 3: Final commit with doc update**

Commit the NEXT_STEPS.md and technical overview changes along with any remaining adjustments:

```
docs: fix React→Express doc drift, update NEXT_STEPS for completed reranking + codex fixes
```

---

## Test Coverage Summary After Implementation

| File | Tests | What's Covered |
|------|-------|----------------|
| `middleware/auth.test.js` | 8 | requireAuth, optionalAuth, requireAdmin |
| `routes/conversations.test.js` | 10 | CRUD, pagination, user isolation |
| `routes/prompts.test.js` | 13 | CRUD, reorder transaction, admin gates, default protection |
| `routes/audit.test.js` | 14 | recent, export (cursor streaming), summary, query lookup, admin gates |
| `api.test.js` | 5 | Chat validation, conversation ownership, health |
| `index.test.js` *(existing)* | 3 | Process error handlers |
| **Total** | **~53** | |

This covers the regression surface area for: auth middleware behavior, input validation on all routes, admin access control, user isolation, the fixed transaction bug, and the fixed cursor-based export.
