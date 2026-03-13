/**
 * Metrics Collector - Service-specific metrics queries
 * Collects detailed metrics from Qdrant, Paperless, Redis, Postgres, Chat-UI
 */

const net = require('net');

class MetricsCollector {
  /**
   * Collect metrics for a service based on its type
   * @param {Object} service - Service config from config.json
   * @returns {Promise<Object>} Metrics object
   */
  async collect(service) {
    const startTime = Date.now();

    try {
      let metrics = {};

      switch (service.type) {
        case 'qdrant':
          metrics = await this.collectQdrantMetrics(service);
          break;
        case 'paperless':
          metrics = await this.collectPaperlessMetrics(service);
          break;
        case 'redis':
          metrics = await this.collectRedisMetrics(service);
          break;
        case 'postgres':
          metrics = await this.collectPostgresMetrics(service);
          break;
        case 'chatui':
          metrics = await this.collectChatUIMetrics(service);
          break;
        default:
          // HTTP services don't have extra metrics
          metrics = {};
      }

      return {
        ...metrics,
        collectionTime: Date.now() - startTime
      };
    } catch (error) {
      return {
        error: error.message,
        collectionTime: Date.now() - startTime
      };
    }
  }

  /**
   * Collect Qdrant vector database metrics
   */
  async collectQdrantMetrics(service) {
    const collectionName = service.collection || 'mattervault_documents';

    // Get collection info
    const response = await fetch(`${service.url}/collections/${collectionName}`);
    if (!response.ok) {
      throw new Error(`Qdrant API error: ${response.status}`);
    }

    const data = await response.json();
    const result = data.result || {};

    const metrics = {
      vector_count: result.points_count || 0,
      indexed_vectors: result.indexed_vectors_count || 0,
      segments_count: result.segments_count || 0,
      status: result.status || 'unknown'
    };

    // Try to get family breakdown
    try {
      const scrollResponse = await fetch(`${service.url}/collections/${collectionName}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          limit: 1,
          with_payload: { include: ['family_id'] },
          with_vector: false
        })
      });

      if (scrollResponse.ok) {
        // Get unique family_ids by scrolling with grouping
        const familyCounts = await this.getQdrantFamilyCounts(service.url, collectionName);
        metrics.vectors_by_family = familyCounts;
      }
    } catch (err) {
      // Family breakdown is optional
      metrics.vectors_by_family = {};
    }

    return metrics;
  }

  /**
   * Get vector counts per family_id from Qdrant (dynamic discovery)
   */
  async getQdrantFamilyCounts(url, collection) {
    const counts = {};

    // Step 1: Discover unique family_ids by paginating through all points
    try {
      const familyIds = new Set();
      let nextPageOffset = null;
      do {
        const body = {
          limit: 1000,
          with_payload: { include: ['family_id'] },
          with_vector: false
        };
        if (nextPageOffset) body.offset = nextPageOffset;

        const scrollResponse = await fetch(`${url}/collections/${collection}/points/scroll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!scrollResponse.ok) break;

        const scrollData = await scrollResponse.json();
        const points = scrollData.result?.points || [];
        for (const point of points) {
          if (point.payload?.family_id) {
            familyIds.add(point.payload.family_id);
          }
        }

        nextPageOffset = scrollData.result?.next_page_offset || null;
      } while (nextPageOffset);

      // Step 2: Count each discovered family
      for (const family of familyIds) {
        try {
          const response = await fetch(`${url}/collections/${collection}/points/count`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filter: {
                must: [{ key: 'family_id', match: { value: family } }]
              },
              exact: true
            })
          });

          if (response.ok) {
            const data = await response.json();
            counts[family] = data.result?.count || 0;
          }
        } catch (err) {
          counts[family] = -1; // Error indicator
        }
      }
    } catch (err) {
      // Discovery failed, return empty counts
    }

    return counts;
  }

  /**
   * Collect Paperless document metrics
   */
  async collectPaperlessMetrics(service) {
    // Get auth token first
    const tokenResponse = await fetch(`${service.url}/api/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.PAPERLESS_USER || 'admin',
        password: process.env.PAPERLESS_PASS || 'mattervault2025'
      })
    });

    if (!tokenResponse.ok) {
      throw new Error('Paperless authentication failed');
    }

    const { token } = await tokenResponse.json();
    const headers = { Authorization: `Token ${token}` };

    // Get document count
    const docsResponse = await fetch(`${service.url}/api/documents/`, { headers });
    if (!docsResponse.ok) {
      throw new Error(`Paperless API error: ${docsResponse.status}`);
    }

    const docsData = await docsResponse.json();

    // Get tags for family breakdown
    let documentsByFamily = {};
    try {
      const tagsResponse = await fetch(`${service.url}/api/tags/`, { headers });
      if (tagsResponse.ok) {
        const tagsData = await tagsResponse.json();
        const familyTags = (tagsData.results || []).filter(t =>
          !['inbox', 'intake', 'processed', 'error', 'pending'].includes(t.name.toLowerCase())
        );
        for (const tag of familyTags) {
          documentsByFamily[tag.name] = tag.document_count || 0;
        }
      }
    } catch (err) {
      // Family breakdown is optional
    }

    return {
      document_count: docsData.count || 0,
      documents_by_family: documentsByFamily
    };
  }

  /**
   * Collect Redis metrics via INFO command
   */
  async collectRedisMetrics(service) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';

      socket.setTimeout(service.timeout || 5000);

      socket.on('connect', () => {
        socket.write('INFO\r\n');
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
        // INFO response ends with a newline after all sections
        if (data.includes('# Keyspace') || data.split('\n').length > 50) {
          socket.end();
        }
      });

      socket.on('close', () => {
        try {
          const metrics = this.parseRedisInfo(data);
          resolve(metrics);
        } catch (err) {
          reject(err);
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Redis connection timeout'));
      });

      socket.connect(service.port, service.host);
    });
  }

  /**
   * Parse Redis INFO response
   */
  parseRedisInfo(data) {
    const lines = data.split('\r\n');
    const info = {};

    for (const line of lines) {
      if (line.includes(':')) {
        const [key, value] = line.split(':');
        info[key] = value;
      }
    }

    return {
      memory_used_mb: Math.round((parseInt(info.used_memory || 0) / 1024 / 1024) * 100) / 100,
      memory_peak_mb: Math.round((parseInt(info.used_memory_peak || 0) / 1024 / 1024) * 100) / 100,
      connected_clients: parseInt(info.connected_clients || 0),
      total_commands: parseInt(info.total_commands_processed || 0),
      uptime_days: Math.round(parseInt(info.uptime_in_seconds || 0) / 86400 * 10) / 10
    };
  }

  /**
   * Collect Postgres metrics via simple TCP query
   * Note: This is a basic check; for full metrics, we'd need pg client
   */
  async collectPostgresMetrics(service) {
    // For now, just verify TCP connectivity
    // Full Postgres metrics would require pg library
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();

      socket.setTimeout(service.timeout || 5000);

      socket.on('connect', () => {
        socket.end();
        resolve({
          connectable: true,
          // Note: Full connection count would require pg_stat_activity query
          // which needs database credentials and pg library
        });
      });

      socket.on('error', (err) => {
        reject(new Error(`Postgres connection failed: ${err.message}`));
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Postgres connection timeout'));
      });

      socket.connect(service.port, service.host);
    });
  }

  /**
   * Collect Chat-UI metrics from enhanced /health endpoint
   */
  async collectChatUIMetrics(service) {
    const response = await fetch(service.url);

    if (!response.ok) {
      throw new Error(`Chat-UI health check failed: ${response.status}`);
    }

    const data = await response.json();

    return {
      db_connected: data.services?.database || false,
      redis_connected: data.services?.redis || false,
      conversation_count: data.metrics?.conversation_count || 0,
      message_count: data.metrics?.message_count || 0,
      active_sessions: data.metrics?.active_sessions || 0,
      last_query_at: data.metrics?.last_query_at || null
    };
  }
}

module.exports = { MetricsCollector };
