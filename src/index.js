const express = require('express');
const path = require('path');
const { Storage } = require('./storage');
const { HealthChecker } = require('./healthChecker');
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
const scheduler = new Scheduler();

// Placeholder broadcast function (WebSocket added in Task 6)
let broadcast = () => {};

// API routes
app.use('/api', createApiRouter(storage, config, scheduler, healthChecker, (msg) => broadcast(msg)));

// Start health checks for all services
function startMonitoring() {
  for (const service of config.services) {
    scheduler.schedule(service, async () => {
      const result = await healthChecker.check(service);
      storage.updateService(service.id, result);
      broadcast({ type: 'status', service: service.id, data: result });
      console.log(`[${service.id}] ${result.status} - ${result.responseTime}ms`);
    });
  }

  // Prune history periodically (every hour)
  setInterval(() => {
    storage.pruneHistory(config.historyRetentionHours);
  }, 60 * 60 * 1000);
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
