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
const router = require('./family-access');

const adminApp = createApp(router, '/api/admin/family-access', { auth: 'admin' });
const userApp = createApp(router, '/api/admin/family-access', { auth: 'user' });

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('GET /api/admin/family-access', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns all assignments for admin', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: '1', user_id: VALID_UUID, family_id: 'morrison' }],
    });
    const res = await request(adminApp).get('/api/admin/family-access');
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp).get('/api/admin/family-access');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/family-access/:userId', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns families for a specific user', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ family_id: 'morrison' }, { family_id: 'johnson' }],
    });
    const res = await request(adminApp).get('/api/admin/family-access/' + VALID_UUID);
    expect(res.status).toBe(200);
    expect(res.body.families).toHaveLength(2);
  });
});

describe('POST /api/admin/family-access', () => {
  afterEach(() => jest.resetAllMocks());

  test('grants family access', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: '1', user_id: VALID_UUID, family_id: 'morrison' }],
    });
    const res = await request(adminApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID, family_id: 'morrison' });
    expect(res.status).toBe(201);
  });

  test('rejects missing fields', async () => {
    const res = await request(adminApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID });
    expect(res.status).toBe(400);
  });

  test('handles duplicate gracefully', async () => {
    db.query.mockRejectedValueOnce({ code: '23505' });
    const res = await request(adminApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID, family_id: 'morrison' });
    expect(res.status).toBe(409);
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID, family_id: 'morrison' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/admin/family-access/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('revokes access', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(adminApp).delete('/api/admin/family-access/' + VALID_UUID);
    expect(res.status).toBe(200);
  });

  test('returns 404 for missing assignment', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(adminApp).delete('/api/admin/family-access/' + VALID_UUID);
    expect(res.status).toBe(404);
  });
});
