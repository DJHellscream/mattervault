const express = require('express');
const { Pool } = require('pg');

// ChatUI database pool for recent queries
let chatuiPool = null;

function getChatuiPool() {
  if (!chatuiPool) {
    chatuiPool = new Pool({
      host: process.env.CHATUI_DB_HOST || 'matterdb-chatui',
      port: parseInt(process.env.CHATUI_DB_PORT || '5432'),
      database: process.env.CHATUI_DB_NAME || 'chatui',
      user: process.env.CHATUI_DB_USER || 'chatui',
      password: process.env.CHATUI_DB_PASS || 'chatui_secure_pass',
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
  }
  return chatuiPool;
}

function createApiRouter(storage, config, scheduler, healthChecker, broadcast, alerter) {
  const router = express.Router();

  // GET /api/status - all services status with metrics
  router.get('/status', (req, res) => {
    const data = storage.getAllServices();
    const services = {};
    let up = 0;
    let down = 0;

    for (const service of config.services) {
      const serviceData = data[service.id];
      if (serviceData && serviceData.current) {
        services[service.id] = {
          ...serviceData.current,
          name: service.name,
          type: service.type
        };
        if (serviceData.current.status === 'up') up++;
        else down++;
      } else {
        services[service.id] = {
          status: 'unknown',
          lastCheck: null,
          name: service.name,
          type: service.type
        };
      }
    }

    res.json({
      services,
      summary: { total: config.services.length, up, down }
    });
  });

  // GET /api/status/:serviceId - single service with history and metrics
  router.get('/status/:serviceId', (req, res) => {
    const serviceData = storage.getServiceData(req.params.serviceId);
    const serviceConfig = config.services.find(s => s.id === req.params.serviceId);

    if (!serviceData && !serviceConfig) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Filter out empty/invalid history entries
    const cleanHistory = (serviceData?.history || []).filter(h => h && h.timestamp && h.status);

    res.json({
      config: serviceConfig,
      current: serviceData?.current,
      history: cleanHistory,
      metrics: serviceData?.metrics
    });
  });

  // GET /api/metrics - all metrics summary
  router.get('/metrics', (req, res) => {
    const data = storage.getAllServices();
    const metrics = {};

    for (const service of config.services) {
      const serviceData = data[service.id];
      // Metrics are stored at serviceData.metrics (separate from current/history)
      if (serviceData?.metrics) {
        metrics[service.id] = {
          name: service.name,
          type: service.type,
          ...serviceData.metrics
        };
      }
    }

    // Calculate summary metrics
    const qdrantMetrics = metrics['qdrant'] || {};
    const paperlessMetrics = metrics['paperless'] || {};
    const chatUIMetrics = metrics['chat-ui'] || {};

    res.json({
      services: metrics,
      summary: {
        total_vectors: qdrantMetrics.vector_count || 0,
        total_documents: paperlessMetrics.document_count || 0,
        total_conversations: chatUIMetrics.conversation_count || 0,
        total_messages: chatUIMetrics.message_count || 0,
        vectors_by_family: qdrantMetrics.vectors_by_family || {},
        documents_by_family: paperlessMetrics.documents_by_family || {}
      }
    });
  });

  // GET /api/alerts - recent alerts
  router.get('/alerts', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const alerts = alerter ? alerter.getRecentAlerts(limit) : [];
    res.json({ alerts });
  });

  // DELETE /api/alerts - clear all alerts
  router.delete('/alerts', (req, res) => {
    if (alerter) {
      alerter.clearAlerts();
      res.json({ success: true, message: 'Alerts cleared' });
    } else {
      res.status(500).json({ success: false, message: 'Alerter not available' });
    }
  });

  // GET /api/config - current configuration
  router.get('/config', (req, res) => {
    // Don't expose passwords
    const safeConfig = {
      ...config,
      services: config.services.map(s => {
        const { password, ...safe } = s;
        return safe;
      })
    };
    res.json(safeConfig);
  });

  // PUT /api/config/services/:serviceId - update service config
  router.put('/config/services/:serviceId', (req, res) => {
    const serviceIndex = config.services.findIndex(s => s.id === req.params.serviceId);
    if (serviceIndex === -1) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const updates = req.body;
    const allowed = ['url', 'interval', 'timeout', 'name'];

    for (const key of Object.keys(updates)) {
      if (allowed.includes(key)) {
        config.services[serviceIndex][key] = updates[key];
      }
    }

    // Reschedule if interval changed
    if (updates.interval) {
      const service = config.services[serviceIndex];
      scheduler.schedule(service, async () => {
        const result = await healthChecker.check(service);
        storage.updateService(service.id, result);
        broadcast({ type: 'status', service: service.id, data: result });
      });
    }

    res.json(config.services[serviceIndex]);
  });

  // POST /api/check/:serviceId - trigger immediate check
  router.post('/check/:serviceId', async (req, res) => {
    const service = config.services.find(s => s.id === req.params.serviceId);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const result = await healthChecker.check(service);
    storage.updateService(service.id, result);
    broadcast({ type: 'status', service: service.id, data: result });

    res.json(result);
  });

  // GET /api/recent-queries - recent audit log entries from chat-ui database
  router.get('/recent-queries', async (req, res) => {
    try {
      const pool = getChatuiPool();
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);

      const result = await pool.query(`
        SELECT
          correlation_id,
          paperless_username,
          family_id,
          query_text,
          total_latency_ms,
          created_at
        FROM audit.chat_query_logs
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);

      res.json({ queries: result.rows });
    } catch (err) {
      // Gracefully handle if audit table doesn't exist yet
      console.error('Recent queries error:', err.message);
      res.json({ queries: [], error: 'Audit logs not available' });
    }
  });

  return router;
}

module.exports = { createApiRouter };
