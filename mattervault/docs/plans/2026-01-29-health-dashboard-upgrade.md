# Health Dashboard Upgrade Design

## Overview

Upgrade the existing health dashboard with service-specific metrics and local alerting.

## Goals

1. Monitor all 12 services (currently only 5)
2. Add meaningful metrics (vector counts, doc counts, not just up/down)
3. Add alerting system (console/file now, email later)
4. Improve UI with better visualization

## Services to Monitor

| Container | Service | Health Check | Metrics |
|-----------|---------|--------------|---------|
| mattercache | Redis | TCP + PING | memory_used_mb, connected_clients |
| matterdb-paperless | Postgres | pg_isready query | connection_count |
| matterdb-n8n | Postgres | pg_isready query | connection_count |
| matterdb-chatui | Postgres | pg_isready query | connection_count |
| matterconvert | Gotenberg | HTTP /health | - |
| matterparse | Tika | HTTP / | - |
| mattervault | Paperless | HTTP /api/ | document_count, trash_count |
| mattermemory | Qdrant | HTTP /healthz | vector_count, vectors_by_family |
| matterlogic | n8n | HTTP /healthz | active_workflows |
| mattervault-chat | Chat-UI | HTTP /health | conversation_count, message_count, active_sessions, last_query_at |
| host | Ollama | HTTP /api/tags | loaded_models |
| host | Docling | HTTP /health | - |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Health Dashboard                              │
├─────────────────────────────────────────────────────────────────┤
│  src/                                                            │
│  ├── index.js           Express app + WebSocket                 │
│  ├── healthChecker.js   Generic HTTP/TCP checks                 │
│  ├── metricsCollector.js Service-specific API queries           │
│  ├── alerter.js         Rule evaluation + transports            │
│  ├── scheduler.js       Cron scheduling                         │
│  ├── storage.js         JSON persistence (24h history)          │
│  └── api.js             REST endpoints                          │
│                                                                  │
│  public/                                                         │
│  ├── index.html         Dashboard UI (use frontend-design)      │
│  └── style.css          Styling                                 │
└─────────────────────────────────────────────────────────────────┘
```

## New Files

### metricsCollector.js

Collects service-specific metrics by querying APIs:

```javascript
// Qdrant metrics
async function getQdrantMetrics(url) {
  const collection = await fetch(`${url}/collections/mattervault_documents_v2`);
  const data = await collection.json();
  return {
    vector_count: data.result.points_count,
    // Also query for family_id breakdown
  };
}

// Paperless metrics
async function getPaperlessMetrics(url, token) {
  const docs = await fetch(`${url}/api/documents/`, { headers: { Authorization: `Token ${token}` }});
  return { document_count: docs.count };
}

// Redis metrics
async function getRedisMetrics(host, port) {
  // Connect and send INFO command
  return { memory_used_mb, connected_clients };
}
```

### alerter.js

Evaluates alert rules and sends notifications:

```javascript
const rules = [
  { id: 'qdrant-empty', condition: (m) => m.qdrant?.vector_count === 0, severity: 'critical', message: 'Qdrant has 0 vectors!' },
  { id: 'service-down', condition: (m) => m.status === 'down', severity: 'warning', message: '{service} is down' },
  { id: 'db-connections', condition: (m) => m.connection_count > 50, severity: 'warning', message: '{service} has high connection count' },
];

// Transports (pluggable)
const transports = {
  console: (alert) => console.log(`[ALERT] ${alert.severity}: ${alert.message}`),
  file: (alert) => fs.appendFileSync('alerts.log', JSON.stringify(alert) + '\n'),
  // email: (alert) => sendEmail(alert),  // Add later
};
```

## Config Changes

Updated `config.json`:

```json
{
  "services": [
    { "id": "redis", "name": "Redis", "type": "redis", "host": "mattercache", "port": 6379 },
    { "id": "db-paperless", "name": "DB Paperless", "type": "postgres", "host": "matterdb-paperless", "port": 5432, "user": "paperless", "pass": "..." },
    { "id": "db-n8n", "name": "DB n8n", "type": "postgres", "host": "matterdb-n8n", "port": 5432, "user": "n8n", "pass": "..." },
    { "id": "db-chatui", "name": "DB ChatUI", "type": "postgres", "host": "matterdb-chatui", "port": 5432, "user": "chatui", "pass": "..." },
    { "id": "gotenberg", "name": "Gotenberg", "type": "http", "url": "http://matterconvert:3000/health" },
    { "id": "tika", "name": "Tika", "type": "http", "url": "http://matterparse:9998/" },
    { "id": "paperless", "name": "Paperless", "type": "paperless", "url": "http://mattervault:8000" },
    { "id": "qdrant", "name": "Qdrant", "type": "qdrant", "url": "http://qdrant:6333" },
    { "id": "n8n", "name": "n8n", "type": "http", "url": "http://matterlogic:5678/healthz" },
    { "id": "chat-ui", "name": "Chat UI", "type": "http", "url": "http://mattervault-chat:3000/health" },
    { "id": "ollama", "name": "Ollama", "type": "http", "url": "http://host.docker.internal:11434/api/tags", "timeout": 10000 },
    { "id": "docling", "name": "Docling", "type": "http", "url": "http://host.docker.internal:5001/health", "timeout": 10000 }
  ],
  "alerts": {
    "enabled": true,
    "transports": ["console", "file"],
    "rules": [
      { "id": "service-down", "severity": "critical" },
      { "id": "qdrant-empty", "severity": "critical" },
      { "id": "no-recent-queries", "threshold_minutes": 60, "severity": "warning" }
    ]
  },
  "intervals": {
    "healthCheck": 30,
    "metricsCollection": 60
  },
  "historyRetentionHours": 24
}
```

## UI Enhancements (via frontend-design skill)

- Service cards with status indicators
- Metrics display (vector count, doc count prominently)
- Alert history panel
- Family breakdown chart for vectors
- 24-hour uptime timeline
- Responsive dark theme

## Implementation Tasks

1. **Update config.json** - Add all 12 services with types
2. **Create metricsCollector.js** - Service-specific API queries
3. **Create alerter.js** - Rule engine + console/file transports
4. **Update healthChecker.js** - Add Redis/Postgres check types
5. **Update index.js** - Wire up metrics + alerts
6. **Update storage.js** - Store metrics alongside status
7. **Update UI** - Use frontend-design skill for enhanced dashboard

## Alert Rules

| Rule | Condition | Severity |
|------|-----------|----------|
| service-down | Any service status = down | critical |
| qdrant-empty | vector_count = 0 | critical |
| paperless-empty | document_count = 0 | warning |
| no-recent-queries | last_query_at > 60 min ago | warning |
| high-db-connections | connection_count > 50 | warning |

## Testing

After implementation:
1. Stop a service, verify alert fires
2. Check Qdrant metrics show correct vector count
3. Check Paperless metrics show correct doc count
4. Verify 24h history persists
5. Verify WebSocket pushes metrics updates

## Future (Email Alerting)

When ready, add to alerter.js:
```javascript
const nodemailer = require('nodemailer');

transports.email = async (alert) => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    to: process.env.ALERT_EMAIL,
    subject: `[Mattervault] ${alert.severity}: ${alert.message}`,
    text: JSON.stringify(alert, null, 2)
  });
};
```
