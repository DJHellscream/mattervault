# Mattervault Health Dashboard Design

A Node.js web dashboard that monitors the health of mattervault services and displays status, response times, and history.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Web Browser                        │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP + WebSocket
┌─────────────────────▼───────────────────────────────┐
│              Express Server (Node.js)                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ REST API    │  │ WebSocket   │  │ Static UI   │  │
│  │ /api/*      │  │ Live updates│  │ /           │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│              Health Check Scheduler                  │
│  Runs checks at configurable intervals per service   │
└─────────────────────┬───────────────────────────────┘
                      │
        ┌─────────┬───┼───┬─────────┐
        ▼         ▼   ▼   ▼         ▼
    ┌───────┐ ┌─────────┐ ┌──────┐ ┌──────┐
    │  n8n  │ │Paperless│ │Qdrant│ │Ollama│
    └───────┘ └─────────┘ └──────┘ └──────┘
```

**Tech stack:**
- Express - HTTP server
- ws - WebSocket for live dashboard updates
- htmx - Lightweight reactive UI without build step
- node-cron - Flexible scheduling per service

## Services Configuration

Each service defined in `config.json`:

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

**Fields:**
- `interval` - Seconds between checks (per-service)
- `timeout` - Max wait time before marking as down
- `type` - `"json"` parses response body, `"http"` just checks for 2xx status

## Data Storage

Health check results stored in `data/history.json`:

```json
{
  "n8n": {
    "current": {
      "status": "up",
      "responseTime": 45,
      "lastCheck": "2026-01-20T21:30:00Z",
      "details": { "status": "ok" }
    },
    "history": [
      {
        "timestamp": "2026-01-20T21:30:00Z",
        "status": "up",
        "responseTime": 45
      }
    ]
  }
}
```

**Behavior:**
- Write after each health check completes
- Automatically prune entries older than `historyRetentionHours`
- Atomic writes (temp file then rename) to prevent corruption
- Load existing history on startup

## Web Dashboard UI

```
┌─────────────────────────────────────────────────────────────┐
│  mattervault health                          Last update: 5s │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────┐│
│  │ ● n8n       │ │ ● Paperless │ │ ● Qdrant    │ │ ● Ollama││
│  │   UP        │ │   UP        │ │   UP        │ │   DOWN  ││
│  │   45ms      │ │   120ms     │ │   12ms      │ │   ---   ││
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────┘│
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 24h History                              ▼ All Services │ │
│  │ ████████████████████████████████░░████████████████████ │ │
│  │ 12:00    15:00    18:00    21:00    00:00    03:00     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Service Details: Ollama                                 │ │
│  │ Status: DOWN since 2026-01-20 21:25:00                 │ │
│  │ Last error: Connection refused                          │ │
│  │ Avg response time (24h): 850ms                          │ │
│  │ Uptime (24h): 98.5%                                     │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Status cards - Color-coded (green/red), shows response time
- History bar - Visual timeline, click to see details
- Detail panel - Expands when clicking a service card
- Live updates - WebSocket pushes new data, no manual refresh

**Implementation:**
- htmx for WebSocket integration and partial page updates
- Minimal vanilla CSS (no framework)
- Single HTML file served by Express

## API Endpoints

```
GET  /api/status
     Returns current status of all services

GET  /api/status/:serviceId
     Returns current status + history for one service

GET  /api/config
     Returns current service configuration

PUT  /api/config/services/:serviceId
     Update a service's settings (url, interval, timeout)

POST /api/check/:serviceId
     Trigger an immediate health check for one service

WebSocket /ws
     Pushes status updates whenever a health check completes
     Message format: { "type": "status", "service": "n8n", "data": {...} }
```

**Response example for `GET /api/status`:**
```json
{
  "services": {
    "n8n": { "status": "up", "responseTime": 45, "lastCheck": "..." },
    "paperless": { "status": "up", "responseTime": 120, "lastCheck": "..." },
    "qdrant": { "status": "up", "responseTime": 12, "lastCheck": "..." },
    "ollama": { "status": "down", "error": "Connection refused", "lastCheck": "..." }
  },
  "summary": { "total": 4, "up": 3, "down": 1 }
}
```

## Docker Setup

**Dockerfile:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
```

**docker-compose.yml:**
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

Access dashboard at `http://localhost:3005`

## Project Structure

```
/workspace
├── config.json
├── data/
│   └── history.json
├── src/
│   ├── index.js          # Entry point, Express setup
│   ├── healthChecker.js  # Health check logic
│   ├── scheduler.js      # Cron scheduling
│   ├── storage.js        # JSON file read/write
│   ├── api.js            # REST endpoints
│   └── websocket.js      # WebSocket handler
├── public/
│   ├── index.html        # Dashboard UI
│   └── style.css         # Styles
├── package.json
├── Dockerfile
└── docker-compose.yml
```
