/**
 * Tests for family access control in auth.js
 */

jest.mock('./db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

// Mock Redis to prevent real connection
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  }));
});

const db = require('./db');
const { userCanAccessFamily } = require('./auth');

describe('userCanAccessFamily', () => {
  afterEach(() => jest.resetAllMocks());

  test('admin always has access', async () => {
    const result = await userCanAccessFamily('admin-id', 'admin', 'morrison');
    expect(result).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('user with access granted returns true', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });
    const result = await userCanAccessFamily('user-id', 'user', 'morrison');
    expect(result).toBe(true);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('user_family_access'),
      ['user-id', 'morrison']
    );
  });

  test('user without access returns false', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await userCanAccessFamily('user-id', 'user', 'johnson');
    expect(result).toBe(false);
  });
});
