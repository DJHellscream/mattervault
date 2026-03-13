/**
 * Route integration tests for prompts.js
 *
 * Tests CRUD + reorder endpoints for prompt library (Quick Actions).
 * The prompts router has its own inline requireAdmin middleware.
 */

const request = require('supertest');

// Mock ../auth BEFORE requiring the router (middleware/auth.js imports it at load time)
jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

// Mock middleware/auth so requireAuth is a passthrough — createApp already injects req.user
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

jest.mock('../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const db = require('../db');
const router = require('./prompts');
const { createApp, TEST_USER, TEST_ADMIN } = require('../test-helpers');

const adminApp = createApp(router, '/api/prompts', { auth: 'admin' });
const userApp = createApp(router, '/api/prompts', { auth: 'user' });

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/prompts
// ---------------------------------------------------------------------------

describe('GET /api/prompts', () => {
  test('regular user sees only enabled prompts', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: VALID_UUID, title: 'Test' }] });

    const res = await request(userApp).get('/api/prompts');

    expect(res.status).toBe(200);
    expect(res.body.prompts).toHaveLength(1);
    // The query for non-admin must filter by enabled = true
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain('enabled = true');
  });

  test('admin sees all prompts', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: VALID_UUID, title: 'Enabled' },
        { id: '00000000-0000-0000-0000-000000000002', title: 'Disabled' },
      ],
    });

    const res = await request(adminApp).get('/api/prompts');

    expect(res.status).toBe(200);
    expect(res.body.prompts).toHaveLength(2);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).not.toContain('enabled = true');
  });
});

// ---------------------------------------------------------------------------
// POST /api/prompts
// ---------------------------------------------------------------------------

describe('POST /api/prompts', () => {
  test('admin can create a prompt (201)', async () => {
    // First query: max sort_order
    db.query.mockResolvedValueOnce({ rows: [{ next_order: 5 }] });
    // Second query: insert
    db.query.mockResolvedValueOnce({
      rows: [{ id: VALID_UUID, title: 'New Prompt', sort_order: 5 }],
    });

    const res = await request(adminApp)
      .post('/api/prompts')
      .send({ title: 'New Prompt', prompt_text: 'Do something' });

    expect(res.status).toBe(201);
    expect(res.body.prompt).toBeDefined();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('rejects missing required fields (400)', async () => {
    const res = await request(adminApp)
      .post('/api/prompts')
      .send({ title: 'Missing prompt_text' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp)
      .post('/api/prompts')
      .send({ title: 'New', prompt_text: 'text' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/prompts/:id
// ---------------------------------------------------------------------------

describe('PUT /api/prompts/:id', () => {
  test('admin can update (200)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: VALID_UUID, title: 'Updated' }],
    });

    const res = await request(adminApp)
      .put(`/api/prompts/${VALID_UUID}`)
      .send({ title: 'Updated', prompt_text: 'Updated text' });

    expect(res.status).toBe(200);
    expect(res.body.prompt.title).toBe('Updated');
  });

  test('rejects invalid UUID (400)', async () => {
    const res = await request(adminApp)
      .put('/api/prompts/not-a-uuid')
      .send({ title: 'X', prompt_text: 'Y' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 for missing prompt', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp)
      .put(`/api/prompts/${VALID_UUID}`)
      .send({ title: 'X', prompt_text: 'Y' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/prompts/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/prompts/:id', () => {
  test('blocks deletion of default prompts (400)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_default: true }] });

    const res = await request(adminApp).delete(`/api/prompts/${VALID_UUID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/default/i);
  });

  test('deletes non-default prompt (200)', async () => {
    // First query: check is_default
    db.query.mockResolvedValueOnce({ rows: [{ is_default: false }] });
    // Second query: delete
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(adminApp).delete(`/api/prompts/${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Prompt deleted');
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('returns 404 for missing prompt', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(adminApp).delete(`/api/prompts/${VALID_UUID}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp).delete(`/api/prompts/${VALID_UUID}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/prompts/reorder
// ---------------------------------------------------------------------------

describe('PATCH /api/prompts/reorder', () => {
  test('reorders with proper transaction on dedicated client', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValueOnce(mockClient);

    const order = [
      { id: VALID_UUID, sort_order: 0 },
      { id: '00000000-0000-0000-0000-000000000002', sort_order: 1 },
    ];

    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Order updated');

    // Transaction lifecycle on the dedicated client
    const clientCalls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(clientCalls[0]).toBe('BEGIN');
    expect(clientCalls[clientCalls.length - 1]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    // db.query should NOT have been called (all queries go through client)
    expect(db.query).not.toHaveBeenCalled();
  });

  test('rejects empty order array (400)', async () => {
    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('rejects invalid UUID in order (400)', async () => {
    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order: [{ id: 'bad-uuid', sort_order: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('rolls back on error and releases client', async () => {
    const mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    // BEGIN succeeds, but the UPDATE fails
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValueOnce(new Error('DB write failure'));

    db.getClient.mockResolvedValueOnce(mockClient);

    const res = await request(adminApp)
      .patch('/api/prompts/reorder')
      .send({ order: [{ id: VALID_UUID, sort_order: 0 }] });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SERVER_ERROR');

    // Should have attempted ROLLBACK after the failure
    const clientCalls = mockClient.query.mock.calls.map((c) => c[0]);
    expect(clientCalls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
