/**
 * Tests for process-level error handlers in index.js
 *
 * These tests verify that unhandledRejection and uncaughtException
 * handlers are registered to prevent silent crashes.
 *
 * We mock the database, Redis, and migrations modules so that
 * requiring index.js doesn't attempt real connections.
 */

// Mock db module before any require
jest.mock('./db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

// Mock migrations module
jest.mock('./migrations', () => ({
  waitForDatabase: jest.fn().mockResolvedValue(),
  runMigrations: jest.fn().mockResolvedValue(),
}));

// Mock auth module (exports redis)
jest.mock('./auth', () => ({
  redis: { ping: jest.fn().mockResolvedValue('PONG') },
  verifyToken: jest.fn(),
  generateTokens: jest.fn(),
}));

// Mock middleware/auth
jest.mock('./middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
}));

// Capture listener counts BEFORE requiring index.js
const rejectionListenersBefore = process.listeners('unhandledRejection').length;
const exceptionListenersBefore = process.listeners('uncaughtException').length;

// Now require the module — this registers the handlers
const { app } = require('./index');

describe('Process Error Handlers', () => {
  test('unhandledRejection handler is registered', () => {
    const listeners = process.listeners('unhandledRejection');
    expect(listeners.length).toBeGreaterThan(rejectionListenersBefore);
  });

  test('uncaughtException handler is registered', () => {
    const listeners = process.listeners('uncaughtException');
    expect(listeners.length).toBeGreaterThan(exceptionListenersBefore);
  });

  test('app is an Express application', () => {
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });
});
