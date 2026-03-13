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
const router = require('./admin-users');

const adminApp = createApp(router, '/api/admin/users', { auth: 'admin' });
const userApp = createApp(router, '/api/admin/users', { auth: 'user' });

describe('GET /api/admin/users', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns all users for admin', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: '1', paperless_username: 'admin', display_name: 'Admin', role: 'admin' },
        { id: '2', paperless_username: 'jsmith', display_name: 'John Smith', role: 'user' },
      ],
    });

    const res = await request(adminApp).get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0].paperless_username).toBe('admin');
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp).get('/api/admin/users');
    expect(res.status).toBe(403);
  });
});
