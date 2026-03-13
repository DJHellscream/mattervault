/**
 * Route integration tests for audit.js
 *
 * Tests admin-only audit log endpoints: recent, export, summary, query.
 */

const request = require('supertest');

// Mock ../auth because ../middleware/auth requires it at import time
jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const { verifyAccessToken } = require('../auth');
const db = require('../db');
const router = require('./audit');
const { createApp, TEST_ADMIN, TEST_USER } = require('../test-helpers');

const adminApp = createApp(router, '/api/audit', { auth: 'admin' });
const userApp = createApp(router, '/api/audit', { auth: 'user' });

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

// Decoded token payloads matching the test-helpers fixtures
const ADMIN_DECODED = {
  userId: TEST_ADMIN.id,
  paperlessUserId: TEST_ADMIN.paperlessUserId,
  paperlessUsername: TEST_ADMIN.paperlessUsername,
  role: 'admin',
  displayName: TEST_ADMIN.displayName,
};

const USER_DECODED = {
  userId: TEST_USER.id,
  paperlessUserId: TEST_USER.paperlessUserId,
  paperlessUsername: TEST_USER.paperlessUsername,
  role: 'user',
  displayName: TEST_USER.displayName,
};

beforeEach(() => {
  jest.resetAllMocks();
});

/** Supertest helper: admin GET */
function adminGet(path) {
  verifyAccessToken.mockReturnValue(ADMIN_DECODED);
  return request(adminApp).get(path).set('Authorization', 'Bearer admin-token');
}

/** Supertest helper: user GET */
function userGet(path) {
  verifyAccessToken.mockReturnValue(USER_DECODED);
  return request(userApp).get(path).set('Authorization', 'Bearer user-token');
}

// ---------------------------------------------------------------------------
// GET /api/audit/recent
// ---------------------------------------------------------------------------
describe('GET /api/audit/recent', () => {
  test('returns paginated logs for admin (200)', async () => {
    const mockLogs = [
      { id: 1, correlation_id: VALID_UUID, query_text: 'test query' },
    ];

    db.query
      .mockResolvedValueOnce({ rows: mockLogs })            // logs query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });   // count query

    const res = await adminGet('/api/audit/recent');

    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual(mockLogs);
    expect(res.body.pagination).toMatchObject({
      total: 1,
      limit: 50,
      offset: 0,
      has_more: false,
    });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('non-admin gets 403', async () => {
    const res = await userGet('/api/audit/recent');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('clamps limit to 200', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const res = await adminGet('/api/audit/recent?limit=999');

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/audit/export
// ---------------------------------------------------------------------------
describe('GET /api/audit/export', () => {
  test('rejects missing dates (400, VALIDATION_ERROR)', async () => {
    const res = await adminGet('/api/audit/export');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('rejects invalid date format (400)', async () => {
    const res = await adminGet(
      '/api/audit/export?start_date=not-a-date&end_date=also-bad'
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('rejects date range exceeding 1 year (400)', async () => {
    const res = await adminGet(
      '/api/audit/export?start_date=2024-01-01&end_date=2025-06-01'
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toMatch(/1 year/);
  });

  test('streams JSONL using cursor on dedicated client', async () => {
    const mockRow = {
      id: 1,
      correlation_id: VALID_UUID,
      query_text: 'hello',
    };

    const mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };

    // Sequence: BEGIN, DECLARE CURSOR, FETCH (row), FETCH (empty), CLOSE, COMMIT
    mockClient.query
      .mockResolvedValueOnce({})                          // BEGIN
      .mockResolvedValueOnce({})                          // DECLARE CURSOR
      .mockResolvedValueOnce({ rows: [mockRow] })         // FETCH batch 1
      .mockResolvedValueOnce({ rows: [] })                // FETCH batch 2 (empty)
      .mockResolvedValueOnce({})                          // CLOSE
      .mockResolvedValueOnce({});                         // COMMIT

    db.getClient.mockResolvedValue(mockClient);

    const res = await adminGet(
      '/api/audit/export?start_date=2026-01-01&end_date=2026-02-01'
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/ndjson/);

    // Body should be valid JSONL (one line per row)
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(mockRow);

    // Verify cursor lifecycle
    expect(mockClient.query).toHaveBeenCalledTimes(6);
    expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN');
    expect(mockClient.query.mock.calls[1][0]).toMatch(/DECLARE/);
    expect(mockClient.query.mock.calls[4][0]).toMatch(/CLOSE/);
    expect(mockClient.query.mock.calls[5][0]).toBe('COMMIT');

    // Client must be released
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('non-admin gets 403', async () => {
    const res = await userGet(
      '/api/audit/export?start_date=2026-01-01&end_date=2026-02-01'
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// GET /api/audit/summary
// ---------------------------------------------------------------------------
describe('GET /api/audit/summary', () => {
  test('defaults to month grouping (200)', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const res = await adminGet('/api/audit/summary');

    expect(res.status).toBe(200);
    expect(res.body.summary.group_by).toBe('month');
  });

  test('groups by user', async () => {
    db.query.mockResolvedValue({
      rows: [{ paperless_username: 'admin', query_count: 5 }],
    });

    const res = await adminGet('/api/audit/summary?group_by=user');

    expect(res.status).toBe(200);
    expect(res.body.summary.group_by).toBe('user');
    expect(res.body.data).toHaveLength(1);
  });

  test('groups by family', async () => {
    db.query.mockResolvedValue({
      rows: [{ family_id: 'morrison', query_count: 10 }],
    });

    const res = await adminGet('/api/audit/summary?group_by=family');

    expect(res.status).toBe(200);
    expect(res.body.summary.group_by).toBe('family');
    expect(res.body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/audit/query/:correlationId
// ---------------------------------------------------------------------------
describe('GET /api/audit/query/:correlationId', () => {
  test('rejects invalid UUID (400)', async () => {
    const res = await adminGet('/api/audit/query/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('returns 404 for missing log', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const res = await adminGet(`/api/audit/query/${VALID_UUID}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('returns audit log by correlation ID (200)', async () => {
    const mockLog = { id: 1, correlation_id: VALID_UUID, query_text: 'test' };
    db.query.mockResolvedValue({ rows: [mockLog] });

    const res = await adminGet(`/api/audit/query/${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.audit_log).toEqual(mockLog);
  });
});
