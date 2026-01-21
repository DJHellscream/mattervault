class HealthChecker {
  async check(service) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), service.timeout);

    try {
      const response = await fetch(service.url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json, text/plain, */*'
        }
      });

      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          status: 'down',
          responseTime,
          lastCheck: new Date().toISOString(),
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }

      let details = null;
      if (service.type === 'json') {
        try {
          details = await response.json();
        } catch {
          // Response wasn't JSON, that's okay for json type
          details = null;
        }
      }

      return {
        status: 'up',
        responseTime,
        lastCheck: new Date().toISOString(),
        details
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;

      let errorMessage = error.message;
      if (error.name === 'AbortError') {
        errorMessage = 'Request timeout';
      }

      return {
        status: 'down',
        responseTime,
        lastCheck: new Date().toISOString(),
        error: errorMessage
      };
    }
  }
}

module.exports = { HealthChecker };
