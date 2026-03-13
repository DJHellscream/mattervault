/**
 * Route integration tests for conversations.js
 *
 * Covers: GET /, POST /, GET /:id, PATCH /:id, DELETE /:id
 * All endpoints enforce user isolation via req.user.id.
 */

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

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/conversations
// ---------------------------------------------------------------------------
describe('GET /api/conversations', () => {
  test('returns paginated conversation list', async () => {
    const now = new Date().toISOString();
    const convRows = [
      {
        id: 'conv-1',
        family_id: 'morrison',
        title: 'First',
        message_count: '3',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'conv-2',
        family_id: 'johnson',
        title: 'Second',
        message_count: '0',
        created_at: now,
        updated_at: now,
      },
    ];

    // First call: conversations query; second call: count query
    db.query
      .mockResolvedValueOnce({ rows: convRows })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });

    const res = await request(app).get('/api/conversations');

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    expect(res.body.conversations[0]).toMatchObject({
      id: 'conv-1',
      familyId: 'morrison',
      title: 'First',
      messageCount: 3,
    });
    expect(res.body.pagination).toMatchObject({
      limit: 20,
      offset: 0,
      total: 2,
      hasMore: false,
    });

    // Verify user isolation: first param should be the test user's id
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1][0]).toBe(TEST_USER.id);
  });

  test('filters by family_id query param', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/api/conversations?family_id=morrison');

    // Conversations query should include family_id param
    const convParams = db.query.mock.calls[0][1];
    expect(convParams).toContain('morrison');

    // Count query should also include family_id param
    const countParams = db.query.mock.calls[1][1];
    expect(countParams).toContain('morrison');
  });

  test('clamps limit to 100', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/api/conversations?limit=999');

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);

    // The limit param passed to the query should be 100, not 999
    const convParams = db.query.mock.calls[0][1];
    expect(convParams).toContain(100);
  });
});

// ---------------------------------------------------------------------------
// POST /api/conversations
// ---------------------------------------------------------------------------
describe('POST /api/conversations', () => {
  test('creates conversation with family_id (201)', async () => {
    const now = new Date().toISOString();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'new-conv',
          family_id: 'morrison',
          title: 'My Chat',
          created_at: now,
          updated_at: now,
        },
      ],
    });

    const res = await request(app)
      .post('/api/conversations')
      .send({ family_id: 'morrison', title: 'My Chat' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'new-conv',
      familyId: 'morrison',
      title: 'My Chat',
    });

    // Verify user id is passed
    expect(db.query.mock.calls[0][1][0]).toBe(TEST_USER.id);
  });

  test('rejects missing family_id (400, VALIDATION_ERROR)', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .send({ title: 'No family' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/conversations/:id
// ---------------------------------------------------------------------------
describe('GET /api/conversations/:id', () => {
  test('returns conversation with messages', async () => {
    const now = new Date().toISOString();

    // First query: conversation lookup
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'conv-1',
          family_id: 'morrison',
          title: 'Test Conv',
          created_at: now,
          updated_at: now,
        },
      ],
    });

    // Second query: messages
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          citations: null,
          created_at: now,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hi there',
          citations: [{ title: 'Doc A' }],
          created_at: now,
        },
      ],
    });

    const res = await request(app).get('/api/conversations/conv-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('conv-1');
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1].citations).toEqual([{ title: 'Doc A' }]);
  });

  test('returns 404 when not found (user isolation)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/conversations/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');

    // Should only have called the conversation query, not messages
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/conversations/:id
// ---------------------------------------------------------------------------
describe('PATCH /api/conversations/:id', () => {
  test('updates title (200)', async () => {
    const now = new Date().toISOString();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'conv-1',
          family_id: 'morrison',
          title: 'Updated Title',
          created_at: now,
          updated_at: now,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .send({ title: 'Updated Title' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated Title');
    expect(db.query.mock.calls[0][1]).toEqual([
      'Updated Title',
      'conv-1',
      TEST_USER.id,
    ]);
  });

  test('rejects missing title (400)', async () => {
    const res = await request(app)
      .patch('/api/conversations/conv-1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('returns 404 for other user conversation', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch('/api/conversations/other-conv')
      .send({ title: 'Hacked' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/conversations/:id', () => {
  test('deletes conversation (200)', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).delete('/api/conversations/conv-1');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);

    // Verify user isolation in delete query
    expect(db.query.mock.calls[0][1]).toEqual(['conv-1', TEST_USER.id]);
  });

  test('returns 404 for other user conversation', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app).delete('/api/conversations/other-conv');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
