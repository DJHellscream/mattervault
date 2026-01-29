const { HealthChecker } = require('./healthChecker');

describe('HealthChecker', () => {
  test('returns up status for successful HTTP response', async () => {
    const checker = new HealthChecker();
    const mockService = {
      id: 'test',
      url: 'https://jsonplaceholder.typicode.com/posts/1',
      timeout: 10000,
      type: 'http'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('up');
    expect(result.responseTime).toBeGreaterThanOrEqual(0);
    expect(result.lastCheck).toBeDefined();
  }, 15000);

  test('returns down status for failed HTTP response', async () => {
    const checker = new HealthChecker();
    const mockService = {
      id: 'test',
      url: 'http://localhost:99999',
      timeout: 1000,
      type: 'http'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('down');
    expect(result.error).toBeDefined();
  });

  test('returns down status for timeout', async () => {
    const checker = new HealthChecker();
    const mockService = {
      id: 'test',
      url: 'http://10.255.255.1', // Non-routable IP that will timeout
      timeout: 100,
      type: 'http'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('down');
    expect(result.error).toBeDefined();
  }, 10000);

  test('parses JSON response for json type', async () => {
    const checker = new HealthChecker();
    const mockService = {
      id: 'test',
      url: 'https://jsonplaceholder.typicode.com/posts/1',
      timeout: 10000,
      type: 'json'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('up');
    expect(result.details).toBeDefined();
    expect(result.details.id).toBe(1);
  }, 15000);
});
