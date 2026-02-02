/**
 * Health Checker - Multi-type health checks
 * Supports HTTP, Redis, Postgres, and specialized service types
 */

const net = require('net');

class HealthChecker {
  /**
   * Check health of a service based on its type
   * @param {Object} service - Service config from config.json
   * @returns {Promise<Object>} Health status
   */
  async check(service) {
    const startTime = Date.now();

    try {
      let result;

      switch (service.type) {
        case 'redis':
          result = await this.checkRedis(service);
          break;
        case 'postgres':
          result = await this.checkPostgres(service);
          break;
        case 'http':
        case 'paperless':
        case 'qdrant':
        case 'chatui':
        default:
          result = await this.checkHttp(service);
          break;
      }

      return {
        ...result,
        responseTime: Date.now() - startTime,
        lastCheck: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'down',
        responseTime: Date.now() - startTime,
        lastCheck: new Date().toISOString(),
        error: error.message
      };
    }
  }

  /**
   * HTTP health check
   */
  async checkHttp(service) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), service.timeout || 5000);

    try {
      const response = await fetch(service.url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json, text/plain, */*'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          status: 'down',
          error: `HTTP ${response.status}: ${response.statusText}`
        };
      }

      let details = null;
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        try {
          details = await response.json();
        } catch {
          details = null;
        }
      }

      return {
        status: 'up',
        details
      };
    } catch (error) {
      clearTimeout(timeoutId);

      let errorMessage = error.message;
      if (error.name === 'AbortError') {
        errorMessage = 'Request timeout';
      }

      return {
        status: 'down',
        error: errorMessage
      };
    }
  }

  /**
   * Redis health check via PING command
   */
  async checkRedis(service) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let responded = false;

      socket.setTimeout(service.timeout || 5000);

      socket.on('connect', () => {
        socket.write('PING\r\n');
      });

      socket.on('data', (data) => {
        responded = true;
        socket.end();

        const response = data.toString().trim();
        if (response === '+PONG') {
          resolve({ status: 'up', details: { response: 'PONG' } });
        } else {
          resolve({ status: 'down', error: `Unexpected response: ${response}` });
        }
      });

      socket.on('close', () => {
        if (!responded) {
          resolve({ status: 'down', error: 'Connection closed without response' });
        }
      });

      socket.on('error', (err) => {
        resolve({ status: 'down', error: err.message });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ status: 'down', error: 'Connection timeout' });
      });

      socket.connect(service.port, service.host);
    });
  }

  /**
   * Postgres health check via TCP connection
   * A full pg_isready would require the pg library
   * This checks if Postgres is accepting connections
   */
  async checkPostgres(service) {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      socket.setTimeout(service.timeout || 5000);

      socket.on('connect', () => {
        // Postgres sends a startup message when connected
        // We just need to verify TCP connectivity
        socket.end();
        resolve({
          status: 'up',
          details: {
            host: service.host,
            port: service.port,
            database: service.database
          }
        });
      });

      socket.on('error', (err) => {
        resolve({
          status: 'down',
          error: `Connection failed: ${err.message}`
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          status: 'down',
          error: 'Connection timeout'
        });
      });

      socket.connect(service.port, service.host);
    });
  }
}

module.exports = { HealthChecker };
