/**
 * Route integration tests for api.js
 *
 * Tests the Express router returned by createApiRouter(config):
 *   POST /api/chat   — validates input, manages conversations, proxies to n8n
 *   GET  /api/health  — simple health check
 */

const request = require('supertest');
const { createApp, TEST_USER } = require('./test-helpers');
const { createApiRouter } = require('./api');
const db = require('./db');

jest.mock('./db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const config = {
  n8n: { webhookUrl: 'http://matterlogic:5678/webhook/chat-api' },
};

const originalFetch = global.fetch;
afterAll(() => {
  global.fetch = originalFetch;
});

let app;

beforeEach(() => {
  jest.clearAllMocks();
  const router = createApiRouter(config);
  app = createApp(router, '/api');
});

describe('POST /api/chat', () => {
  test('rejects missing family_id with 400', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ question: 'What is the trust?' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/family_id/);
  });

  test('rejects missing question with 400', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ family_id: 'morrison' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question/);
  });

  test('creates new conversation when no conversation_id provided', async () => {
    // Mock db.query calls in order:
    // 1. INSERT conversation -> returns new id
    // 2. INSERT user message
    // 3. INSERT assistant message
    // 4. UPDATE conversation timestamp
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'new-conv-id' }] }) // INSERT conversation
      .mockResolvedValueOnce({ rows: [] })                       // INSERT user message
      .mockResolvedValueOnce({ rows: [] })                       // INSERT assistant message
      .mockResolvedValueOnce({ rows: [] });                      // UPDATE conversation

    // Mock global.fetch for n8n webhook call
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: 'Answer', citations: [] }),
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ family_id: 'morrison', question: 'What is the trust?' });

    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe('new-conv-id');
  });

  test('verifies ownership of existing conversation and returns 404 if not found', async () => {
    // Mock db.query: SELECT for ownership check returns empty rows
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/chat')
      .send({
        family_id: 'morrison',
        question: 'What is the trust?',
        conversation_id: 'nonexistent-conv-id',
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/health', () => {
  test('returns ok with 200', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
