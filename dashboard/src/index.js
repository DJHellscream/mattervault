const express = require('express');
const path = require('path');
const { Storage } = require('./storage');
const { HealthChecker } = require('./healthChecker');
const { MetricsCollector } = require('./metricsCollector');
const { Alerter } = require('./alerter');
const { Scheduler } = require('./scheduler');
const { createApiRouter } = require('./api');
const { setupWebSocket } = require('./websocket');

const config = require('../config.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize components
const storage = new Storage(path.join(__dirname, '../data/history.json'));
const healthChecker = new HealthChecker();
const metricsCollector = new MetricsCollector();
const alerter = new Alerter(config.alerts || {});
const scheduler = new Scheduler();

// Placeholder broadcast function (WebSocket will set this)
let broadcast = () => {};

// Track previous status for recovery detection
const previousStatus = {};

// API routes
app.use('/api', createApiRouter(storage, config, scheduler, healthChecker, (msg) => broadcast(msg), alerter));

/**
 * Run health check for a service
 */
async function runHealthCheck(service) {
  const result = await healthChecker.check(service);

  // Check for recovery
  if (previousStatus[service.id]) {
    alerter.handleRecovery(service, previousStatus[service.id], result);
  }
  previousStatus[service.id] = result;

  // Get current metrics if available
  const currentData = storage.getServiceData(service.id);
  const metrics = currentData?.metrics || {};

  // Evaluate alert rules
  const alerts = alerter.evaluate(service, result, metrics);
  if (alerts.length > 0) {
    await alerter.send(alerts);
  }

  // Update storage with health status
  storage.updateService(service.id, {
    ...result,
    metrics: currentData?.metrics // Preserve existing metrics
  });

  // Broadcast to WebSocket clients
  broadcast({
    type: 'status',
    service: service.id,
    data: { ...result, metrics: currentData?.metrics }
  });

  console.log(`[${service.id}] ${result.status} - ${result.responseTime}ms`);
}

/**
 * Run metrics collection for a service
 */
async function runMetricsCollection(service) {
  // Only collect metrics for services that have them
  const metricsTypes = ['qdrant', 'paperless', 'redis', 'postgres', 'chatui'];
  if (!metricsTypes.includes(service.type)) {
    return;
  }

  try {
    const metrics = await metricsCollector.collect(service);

    // Get current status
    const currentData = storage.getServiceData(service.id);

    // Merge metrics with existing data
    const updatedData = {
      ...(currentData || {}),
      metrics
    };

    storage.updateService(service.id, updatedData);

    // Evaluate alert rules with new metrics
    const alerts = alerter.evaluate(service, currentData, metrics);
    if (alerts.length > 0) {
      await alerter.send(alerts);
    }

    // Broadcast metrics update
    broadcast({
      type: 'metrics',
      service: service.id,
      data: metrics
    });

    console.log(`[${service.id}] Metrics collected:`, JSON.stringify(metrics).substring(0, 100));
  } catch (error) {
    console.error(`[${service.id}] Metrics collection failed:`, error.message);
  }
}

/**
 * Start health checks and metrics collection
 */
function startMonitoring() {
  const healthInterval = (config.intervals?.healthCheck || 30) * 1000;
  const metricsInterval = (config.intervals?.metricsCollection || 60) * 1000;

  // Schedule health checks
  for (const service of config.services) {
    // Initial check
    runHealthCheck(service);

    // Recurring health checks
    scheduler.schedule(service, () => runHealthCheck(service));
  }

  // Schedule metrics collection (less frequent)
  setInterval(() => {
    for (const service of config.services) {
      runMetricsCollection(service);
    }
  }, metricsInterval);

  // Initial metrics collection after a short delay
  setTimeout(() => {
    for (const service of config.services) {
      runMetricsCollection(service);
    }
  }, 5000);

  // Prune history periodically (every hour)
  setInterval(() => {
    storage.pruneHistory(config.historyRetentionHours || 24);
    alerter.pruneAlerts(7); // Keep 7 days of alerts
  }, 60 * 60 * 1000);

  console.log(`Monitoring ${config.services.length} services`);
  console.log(`Health check interval: ${healthInterval / 1000}s`);
  console.log(`Metrics collection interval: ${metricsInterval / 1000}s`);
}

// Serve index for SPA
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Health dashboard running on port ${PORT}`);
  startMonitoring();
});

// Setup WebSocket
setupWebSocket(server, (fn) => { broadcast = fn; });

module.exports = { app, server };
