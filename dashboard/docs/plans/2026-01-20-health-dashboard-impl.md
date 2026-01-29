# Health Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Node.js web dashboard that monitors mattervault services (n8n, Paperless, Qdrant, Ollama) and displays health status, response times, and 24h history.

**Architecture:** Express server with WebSocket for live updates. Health checks run on configurable intervals per service. Results stored in JSON file. Frontend uses htmx for reactivity without a build step.

**Tech Stack:** Node.js 20, Express, ws (WebSocket), node-cron, htmx

**Design Reference:** See `docs/plans/2026-01-20-health-dashboard-design.md`

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `config.json`
- Create: `src/index.js`
- Create: `data/.gitkeep`

**Step 1: Initialize package.json**

```bash
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install express ws node-cron
```

**Step 3: Create config.json**

Create file `config.json`:

```json
{
  "services": [
    {
      "id": "n8n",
      "name": "n8n",
      "url": "http://n8n:5678/healthz",
      "interval": 60,
      "timeout": 5000,
      "type": "json"
    },
    {
      "id": "paperless",
      "name": "Paperless",
      "url": "http://paperless:8000",
      "interval": 60,
      "timeout": 5000,
      "type": "http"
    },
    {
      "id": "qdrant",
      "name": "Qdrant",
      "url": "http://qdrant:6333/healthz",
      "interval": 60,
      "timeout": 5000,
      "type": "json"
    },
    {
      "id": "ollama",
      "name": "Ollama",
      "url": "http://host.docker.internal:11434/api/tags",
      "interval": 60,
      "timeout": 10000,
      "type": "json"
    }
  ],
  "historyRetentionHours": 24
}
```

**Step 4: Create minimal src/index.js**

Create file `src/index.js`:

```javascript
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Health Dashboard - Coming Soon');
});

app.listen(PORT, () => {
  console.log(`Health dashboard running on port ${PORT}`);
});
```

**Step 5: Create data directory**

```bash
mkdir -p data && touch data/.gitkeep
```

**Step 6: Add start script to package.json**

Edit `package.json` to add in scripts section:

```json
"scripts": {
  "start": "node src/index.js"
}
```

**Step 7: Verify server starts**

Run: `npm start`
Expected: "Health dashboard running on port 3000"
Stop with Ctrl+C

**Step 8: Commit**

```bash
git add package.json package-lock.json config.json src/index.js data/.gitkeep
git commit -m "feat: initialize project with Express server"
```

---

## Task 2: Storage Module

**Files:**
- Create: `src/storage.js`
- Create: `src/storage.test.js`

**Step 1: Write failing test for storage**

Create file `src/storage.test.js`:

```javascript
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
```

**Step 2: Install Jest**

```bash
npm install --save-dev jest
```

**Step 3: Add test script to package.json**

Edit `package.json` scripts:

```json
"scripts": {
  "start": "node src/index.js",
  "test": "jest"
}
```

**Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module './storage'"

**Step 5: Implement storage module**

Create file `src/storage.js`:

```javascript
const fs = require('fs');
const path = require('path');

class Storage {
  constructor(filePath) {
    this.filePath = filePath;
    this.ensureDirectory();
  }

  ensureDirectory() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      const content = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error('Error loading storage:', error.message);
      return {};
    }
  }

  save(data) {
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  updateService(serviceId, result) {
    const data = this.load();

    if (!data[serviceId]) {
      data[serviceId] = { current: null, history: [] };
    }

    data[serviceId].current = result;
    data[serviceId].history.push({
      timestamp: result.lastCheck,
      status: result.status,
      responseTime: result.responseTime
    });

    this.save(data);
  }

  pruneHistory(retentionHours) {
    const data = this.load();
    const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);

    for (const serviceId of Object.keys(data)) {
      if (data[serviceId].history) {
        data[serviceId].history = data[serviceId].history.filter(entry => {
          return new Date(entry.timestamp).getTime() > cutoff;
        });
      }
    }

    this.save(data);
  }

  getServiceData(serviceId) {
    const data = this.load();
    return data[serviceId] || null;
  }

  getAllServices() {
    return this.load();
  }
}

module.exports = { Storage };
```

**Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All 4 tests PASS

**Step 7: Commit**

```bash
git add src/storage.js src/storage.test.js package.json package-lock.json
git commit -m "feat: add storage module with JSON persistence"
```

---

## Task 3: Health Checker Module

**Files:**
- Create: `src/healthChecker.js`
- Create: `src/healthChecker.test.js`

**Step 1: Write failing test for health checker**

Create file `src/healthChecker.test.js`:

```javascript
const { HealthChecker } = require('./healthChecker');

describe('HealthChecker', () => {
  test('returns up status for successful HTTP response', async () => {
    const checker = new HealthChecker();
    const mockService = {
      id: 'test',
      url: 'https://httpstat.us/200',
      timeout: 5000,
      type: 'http'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('up');
    expect(result.responseTime).toBeGreaterThanOrEqual(0);
    expect(result.lastCheck).toBeDefined();
  });

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
      url: 'https://httpstat.us/200?sleep=5000',
      timeout: 100,
      type: 'http'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('down');
    expect(result.error).toMatch(/timeout|aborted/i);
  });

  test('parses JSON response for json type', async () => {
    const checker = new HealthChecker();
    const mockService = {
      id: 'test',
      url: 'https://httpstat.us/200',
      timeout: 5000,
      type: 'json'
    };

    const result = await checker.check(mockService);

    expect(result.status).toBe('up');
    // httpstat.us returns JSON, so details should be populated
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/healthChecker.test.js`
Expected: FAIL with "Cannot find module './healthChecker'"

**Step 3: Implement health checker module**

Create file `src/healthChecker.js`:

```javascript
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
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/healthChecker.test.js`
Expected: All 4 tests PASS (note: these tests hit real URLs)

**Step 5: Commit**

```bash
git add src/healthChecker.js src/healthChecker.test.js
git commit -m "feat: add health checker module"
```

---

## Task 4: Scheduler Module

**Files:**
- Create: `src/scheduler.js`
- Create: `src/scheduler.test.js`

**Step 1: Write failing test for scheduler**

Create file `src/scheduler.test.js`:

```javascript
const { Scheduler } = require('./scheduler');

describe('Scheduler', () => {
  test('schedules a job and executes callback', (done) => {
    const scheduler = new Scheduler();
    let callCount = 0;

    const service = {
      id: 'test',
      interval: 1 // 1 second for testing
    };

    scheduler.schedule(service, () => {
      callCount++;
      if (callCount >= 1) {
        scheduler.stop(service.id);
        expect(callCount).toBeGreaterThanOrEqual(1);
        done();
      }
    });

    // The callback should fire after 1 second
  }, 5000);

  test('stops a scheduled job', () => {
    const scheduler = new Scheduler();
    const service = { id: 'test', interval: 60 };

    scheduler.schedule(service, () => {});
    expect(scheduler.isRunning(service.id)).toBe(true);

    scheduler.stop(service.id);
    expect(scheduler.isRunning(service.id)).toBe(false);
  });

  test('stops all scheduled jobs', () => {
    const scheduler = new Scheduler();

    scheduler.schedule({ id: 'test1', interval: 60 }, () => {});
    scheduler.schedule({ id: 'test2', interval: 60 }, () => {});

    scheduler.stopAll();

    expect(scheduler.isRunning('test1')).toBe(false);
    expect(scheduler.isRunning('test2')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/scheduler.test.js`
Expected: FAIL with "Cannot find module './scheduler'"

**Step 3: Implement scheduler module**

Create file `src/scheduler.js`:

```javascript
const cron = require('node-cron');

class Scheduler {
  constructor() {
    this.jobs = new Map();
  }

  schedule(service, callback) {
    if (this.jobs.has(service.id)) {
      this.stop(service.id);
    }

    // Convert seconds to cron expression
    // For intervals < 60s, use setInterval instead
    if (service.interval < 60) {
      const intervalId = setInterval(callback, service.interval * 1000);
      this.jobs.set(service.id, { type: 'interval', id: intervalId });
      // Run immediately on schedule
      callback();
    } else {
      // For 60+ seconds, use cron with minute-level granularity
      const minutes = Math.floor(service.interval / 60);
      const cronExpression = `*/${minutes} * * * *`;

      const job = cron.schedule(cronExpression, callback);
      this.jobs.set(service.id, { type: 'cron', job });
      // Run immediately on schedule
      callback();
    }
  }

  stop(serviceId) {
    const jobInfo = this.jobs.get(serviceId);
    if (jobInfo) {
      if (jobInfo.type === 'interval') {
        clearInterval(jobInfo.id);
      } else if (jobInfo.type === 'cron') {
        jobInfo.job.stop();
      }
      this.jobs.delete(serviceId);
    }
  }

  stopAll() {
    for (const serviceId of this.jobs.keys()) {
      this.stop(serviceId);
    }
  }

  isRunning(serviceId) {
    return this.jobs.has(serviceId);
  }
}

module.exports = { Scheduler };
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/scheduler.test.js`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/scheduler.js src/scheduler.test.js
git commit -m "feat: add scheduler module for health check intervals"
```

---

## Task 5: API Routes

**Files:**
- Create: `src/api.js`
- Modify: `src/index.js`

**Step 1: Create API routes module**

Create file `src/api.js`:

```javascript
const express = require('express');

function createApiRouter(storage, config, scheduler, healthChecker, broadcast) {
  const router = express.Router();

  // GET /api/status - all services status
  router.get('/status', (req, res) => {
    const data = storage.getAllServices();
    const services = {};
    let up = 0;
    let down = 0;

    for (const service of config.services) {
      const serviceData = data[service.id];
      if (serviceData && serviceData.current) {
        services[service.id] = serviceData.current;
        if (serviceData.current.status === 'up') up++;
        else down++;
      } else {
        services[service.id] = { status: 'unknown', lastCheck: null };
      }
    }

    res.json({
      services,
      summary: { total: config.services.length, up, down }
    });
  });

  // GET /api/status/:serviceId - single service with history
  router.get('/status/:serviceId', (req, res) => {
    const serviceData = storage.getServiceData(req.params.serviceId);
    if (!serviceData) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json(serviceData);
  });

  // GET /api/config - current configuration
  router.get('/config', (req, res) => {
    res.json(config);
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

  return router;
}

module.exports = { createApiRouter };
```

**Step 2: Update index.js to use API routes**

Replace contents of `src/index.js`:

```javascript
const express = require('express');
const path = require('path');
const { Storage } = require('./storage');
const { HealthChecker } = require('./healthChecker');
const { Scheduler } = require('./scheduler');
const { createApiRouter } = require('./api');

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

// Export for WebSocket setup
module.exports = { app, server, setBroadcast: (fn) => { broadcast = fn; } };
```

**Step 3: Create public directory**

```bash
mkdir -p public
```

**Step 4: Create placeholder index.html**

Create file `public/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Health Dashboard</title>
</head>
<body>
  <h1>Health Dashboard</h1>
  <p>API available at /api/status</p>
</body>
</html>
```

**Step 5: Test API manually**

Run: `npm start`
In another terminal: `curl http://localhost:3000/api/status`
Expected: JSON response with services object
Stop server with Ctrl+C

**Step 6: Commit**

```bash
git add src/api.js src/index.js public/index.html
git commit -m "feat: add REST API endpoints"
```

---

## Task 6: WebSocket Support

**Files:**
- Create: `src/websocket.js`
- Modify: `src/index.js`

**Step 1: Create WebSocket module**

Create file `src/websocket.js`:

```javascript
const WebSocket = require('ws');

function setupWebSocket(server, setBroadcast) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('WebSocket client connected');

    ws.on('close', () => {
      clients.delete(ws);
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      clients.delete(ws);
    });
  });

  // Set up broadcast function
  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  };

  setBroadcast(broadcast);

  return wss;
}

module.exports = { setupWebSocket };
```

**Step 2: Update index.js to initialize WebSocket**

Add after the server creation in `src/index.js` (before module.exports):

```javascript
const { setupWebSocket } = require('./websocket');

// ... existing code ...

const server = app.listen(PORT, () => {
  console.log(`Health dashboard running on port ${PORT}`);
  startMonitoring();
});

// Setup WebSocket
setupWebSocket(server, (fn) => { broadcast = fn; });

module.exports = { app, server };
```

**Step 3: Test WebSocket manually**

Run: `npm start`
In browser console or wscat: `new WebSocket('ws://localhost:3000/ws')`
Expected: Connection established, receives status updates

**Step 4: Commit**

```bash
git add src/websocket.js src/index.js
git commit -m "feat: add WebSocket for live status updates"
```

---

## Task 7: Dashboard UI

**Files:**
- Modify: `public/index.html`
- Create: `public/style.css`

**Step 1: Create stylesheet**

Create file `public/style.css`:

```css
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #1a1a2e;
  color: #eee;
  min-height: 100vh;
  padding: 20px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 1px solid #333;
}

h1 {
  font-size: 1.5rem;
  font-weight: 500;
}

.last-update {
  color: #888;
  font-size: 0.9rem;
}

.services-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 20px;
  margin-bottom: 30px;
}

.service-card {
  background: #252540;
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

.service-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}

.service-card.selected {
  box-shadow: 0 0 0 2px #6366f1;
}

.service-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.status-dot.up {
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e;
}

.status-dot.down {
  background: #ef4444;
  box-shadow: 0 0 8px #ef4444;
}

.status-dot.unknown {
  background: #888;
}

.service-name {
  font-weight: 500;
}

.service-status {
  font-size: 1.2rem;
  font-weight: 600;
  text-transform: uppercase;
  margin-bottom: 5px;
}

.service-status.up {
  color: #22c55e;
}

.service-status.down {
  color: #ef4444;
}

.service-status.unknown {
  color: #888;
}

.response-time {
  color: #888;
  font-size: 0.9rem;
}

.history-section {
  background: #252540;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 30px;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.history-bar {
  display: flex;
  height: 30px;
  gap: 2px;
  overflow: hidden;
  border-radius: 4px;
}

.history-segment {
  flex: 1;
  min-width: 3px;
}

.history-segment.up {
  background: #22c55e;
}

.history-segment.down {
  background: #ef4444;
}

.history-segment.unknown {
  background: #444;
}

.history-times {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  color: #666;
  font-size: 0.8rem;
}

.details-section {
  background: #252540;
  border-radius: 12px;
  padding: 20px;
}

.details-section h3 {
  margin-bottom: 15px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid #333;
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  color: #888;
}

.detail-value {
  font-weight: 500;
}

.detail-value.up {
  color: #22c55e;
}

.detail-value.down {
  color: #ef4444;
}

.hidden {
  display: none;
}
```

**Step 2: Create dashboard HTML**

Replace contents of `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mattervault health</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>mattervault health</h1>
    <span class="last-update">Last update: <span id="lastUpdate">--</span></span>
  </header>

  <section class="services-grid" id="servicesGrid">
    <!-- Service cards rendered by JS -->
  </section>

  <section class="history-section">
    <div class="history-header">
      <h3>24h History</h3>
      <select id="historyFilter">
        <option value="all">All Services</option>
      </select>
    </div>
    <div class="history-bar" id="historyBar">
      <!-- History segments rendered by JS -->
    </div>
    <div class="history-times">
      <span id="historyStart">--</span>
      <span id="historyEnd">--</span>
    </div>
  </section>

  <section class="details-section hidden" id="detailsSection">
    <h3>Service Details: <span id="detailsName">--</span></h3>
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span class="detail-value" id="detailsStatus">--</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Last Check</span>
      <span class="detail-value" id="detailsLastCheck">--</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Response Time</span>
      <span class="detail-value" id="detailsResponseTime">--</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Avg Response (24h)</span>
      <span class="detail-value" id="detailsAvgResponse">--</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Uptime (24h)</span>
      <span class="detail-value" id="detailsUptime">--</span>
    </div>
    <div class="detail-row" id="detailsErrorRow">
      <span class="detail-label">Last Error</span>
      <span class="detail-value" id="detailsError">--</span>
    </div>
  </section>

  <script>
    let statusData = { services: {} };
    let selectedService = null;
    let ws = null;

    // Initialize
    async function init() {
      await fetchStatus();
      connectWebSocket();
      renderServices();
      renderHistory();
    }

    // Fetch initial status
    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        statusData = await res.json();
      } catch (err) {
        console.error('Failed to fetch status:', err);
      }
    }

    // WebSocket connection
    function connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
          statusData.services[msg.service] = msg.data;
          updateServiceCard(msg.service, msg.data);
          updateLastUpdate();
          if (selectedService === msg.service) {
            showDetails(msg.service);
          }
        }
      };

      ws.onclose = () => {
        setTimeout(connectWebSocket, 3000);
      };
    }

    // Render service cards
    function renderServices() {
      const grid = document.getElementById('servicesGrid');
      const filter = document.getElementById('historyFilter');
      grid.innerHTML = '';

      for (const [id, data] of Object.entries(statusData.services)) {
        const card = document.createElement('div');
        card.className = 'service-card';
        card.id = `card-${id}`;
        card.onclick = () => selectService(id);
        card.innerHTML = `
          <div class="service-header">
            <span class="status-dot ${data.status}"></span>
            <span class="service-name">${id}</span>
          </div>
          <div class="service-status ${data.status}">${data.status}</div>
          <div class="response-time">${data.responseTime ? data.responseTime + 'ms' : '---'}</div>
        `;
        grid.appendChild(card);

        // Add to filter dropdown
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        filter.appendChild(option);
      }

      updateLastUpdate();
    }

    // Update single service card
    function updateServiceCard(id, data) {
      const card = document.getElementById(`card-${id}`);
      if (card) {
        card.querySelector('.status-dot').className = `status-dot ${data.status}`;
        card.querySelector('.service-status').className = `service-status ${data.status}`;
        card.querySelector('.service-status').textContent = data.status;
        card.querySelector('.response-time').textContent = data.responseTime ? data.responseTime + 'ms' : '---';
      }
    }

    // Select service and show details
    function selectService(id) {
      document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
      document.getElementById(`card-${id}`).classList.add('selected');
      selectedService = id;
      showDetails(id);
    }

    // Show service details
    async function showDetails(id) {
      try {
        const res = await fetch(`/api/status/${id}`);
        const data = await res.json();

        document.getElementById('detailsSection').classList.remove('hidden');
        document.getElementById('detailsName').textContent = id;

        const current = data.current || {};
        document.getElementById('detailsStatus').textContent = current.status || 'unknown';
        document.getElementById('detailsStatus').className = `detail-value ${current.status || 'unknown'}`;
        document.getElementById('detailsLastCheck').textContent = current.lastCheck ? new Date(current.lastCheck).toLocaleString() : '--';
        document.getElementById('detailsResponseTime').textContent = current.responseTime ? current.responseTime + 'ms' : '--';

        // Calculate averages from history
        const history = data.history || [];
        if (history.length > 0) {
          const avgResponse = Math.round(history.reduce((sum, h) => sum + (h.responseTime || 0), 0) / history.length);
          const upCount = history.filter(h => h.status === 'up').length;
          const uptime = Math.round((upCount / history.length) * 100 * 10) / 10;

          document.getElementById('detailsAvgResponse').textContent = avgResponse + 'ms';
          document.getElementById('detailsUptime').textContent = uptime + '%';
        } else {
          document.getElementById('detailsAvgResponse').textContent = '--';
          document.getElementById('detailsUptime').textContent = '--';
        }

        // Show error if down
        const errorRow = document.getElementById('detailsErrorRow');
        if (current.error) {
          errorRow.style.display = 'flex';
          document.getElementById('detailsError').textContent = current.error;
        } else {
          errorRow.style.display = 'none';
        }

        // Update history for this service
        renderHistory(id, history);
      } catch (err) {
        console.error('Failed to fetch details:', err);
      }
    }

    // Render history bar
    function renderHistory(serviceId = null, history = []) {
      const bar = document.getElementById('historyBar');

      if (!history.length) {
        bar.innerHTML = '<div class="history-segment unknown" style="flex:1"></div>';
        document.getElementById('historyStart').textContent = '--';
        document.getElementById('historyEnd').textContent = '--';
        return;
      }

      // Show last 100 data points
      const points = history.slice(-100);
      bar.innerHTML = points.map(h =>
        `<div class="history-segment ${h.status}" title="${new Date(h.timestamp).toLocaleString()}"></div>`
      ).join('');

      document.getElementById('historyStart').textContent = new Date(points[0].timestamp).toLocaleTimeString();
      document.getElementById('historyEnd').textContent = new Date(points[points.length - 1].timestamp).toLocaleTimeString();
    }

    // Update last update time
    function updateLastUpdate() {
      document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
    }

    // History filter change
    document.getElementById('historyFilter').onchange = async (e) => {
      if (e.target.value === 'all') {
        renderHistory();
      } else {
        selectService(e.target.value);
      }
    };

    init();
  </script>
</body>
</html>
```

**Step 3: Test dashboard manually**

Run: `npm start`
Open browser to: http://localhost:3000
Expected: Dashboard UI loads, shows services (may show unknown/down since services aren't available locally)

**Step 4: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: add dashboard UI with live WebSocket updates"
```

---

## Task 8: Docker Configuration

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Create: `.dockerignore`

**Step 1: Create .dockerignore**

Create file `.dockerignore`:

```
node_modules
npm-debug.log
data/history.json
.git
.gitignore
*.md
```

**Step 2: Update Dockerfile**

Replace contents of `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
```

**Step 3: Update docker-compose.yml**

Replace contents of `docker-compose.yml`:

```yaml
services:
  health-dashboard:
    build: .
    ports:
      - "3005:3000"
    volumes:
      - ./data:/app/data
      - ./config.json:/app/config.json
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    networks:
      - mattervault

networks:
  mattervault:
    external: true
```

**Step 4: Build Docker image**

Run: `docker build -t health-dashboard .`
Expected: Image builds successfully

**Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: update Docker configuration for dashboard"
```

---

## Task 9: Final Testing & Cleanup

**Files:**
- Create: `.gitignore`

**Step 1: Create .gitignore**

Create file `.gitignore`:

```
node_modules/
data/history.json
*.log
.DS_Store
```

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 3: Test full application locally**

Run: `npm start`
- Verify dashboard loads at http://localhost:3000
- Verify API responds at http://localhost:3000/api/status
- Verify WebSocket connects
Stop with Ctrl+C

**Step 4: Final commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore and finalize project"
```

**Step 5: Verify git log**

Run: `git log --oneline`
Expected: Series of commits showing feature progression

---

## Summary

Implementation complete. The dashboard:

1. Monitors 4 services: n8n, Paperless, Qdrant, Ollama
2. Stores history in JSON file with 24h retention
3. Provides REST API for status and configuration
4. Updates UI live via WebSocket
5. Runs in Docker on port 3005

**To run:**
```bash
docker-compose up -d
```

**To access:**
http://localhost:3005
