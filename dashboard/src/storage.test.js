const fs = require('fs');
const path = require('path');
const { Storage } = require('./storage');

const TEST_FILE = path.join(__dirname, '../data/test-history.json');

describe('Storage', () => {
  let storage;

  beforeEach(() => {
    storage = new Storage(TEST_FILE);
    if (fs.existsSync(TEST_FILE)) {
      fs.unlinkSync(TEST_FILE);
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_FILE)) {
      fs.unlinkSync(TEST_FILE);
    }
  });

  test('initializes with empty data if file does not exist', () => {
    const data = storage.load();
    expect(data).toEqual({});
  });

  test('saves and loads data', () => {
    const testData = {
      n8n: {
        current: { status: 'up', responseTime: 45 },
        history: []
      }
    };
    storage.save(testData);
    const loaded = storage.load();
    expect(loaded).toEqual(testData);
  });

  test('updates service data', () => {
    storage.updateService('n8n', {
      status: 'up',
      responseTime: 45,
      lastCheck: '2026-01-20T12:00:00Z'
    });
    const data = storage.load();
    expect(data.n8n.current.status).toBe('up');
    expect(data.n8n.history).toHaveLength(1);
  });

  test('prunes history older than retention period', () => {
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const newTimestamp = new Date().toISOString();

    storage.save({
      n8n: {
        current: { status: 'up' },
        history: [
          { timestamp: oldTimestamp, status: 'up' },
          { timestamp: newTimestamp, status: 'up' }
        ]
      }
    });

    storage.pruneHistory(24);
    const data = storage.load();
    expect(data.n8n.history).toHaveLength(1);
    expect(data.n8n.history[0].timestamp).toBe(newTimestamp);
  });
});
