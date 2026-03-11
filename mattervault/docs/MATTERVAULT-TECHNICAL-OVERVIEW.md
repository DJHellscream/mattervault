# Mattervault Technical Overview

**Version 1.0** | **Document Intelligence Platform for Legal & Estate Planning**

---

## System Summary

Mattervault is a fully containerized, air-gapped document intelligence system designed for organizations handling sensitive legal documents. It combines document management, semantic search, and AI-powered chat capabilities while maintaining complete data sovereignty—no external API calls, no cloud dependencies.

**Primary Use Case**: Law firms and estate planning practices requiring intelligent document retrieval with compliance-grade audit trails.

---

## Architecture Overview

Mattervault employs a 5-zone modular architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Chat UI (3007)              │  Health Dashboard (3006)                     │
│  React + Express.js          │  Real-time monitoring + WebSocket            │
└──────────────┬───────────────┴──────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────────────┐
│                           ORCHESTRATION LAYER                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                             n8n (5678)                                       │
│         Webhook-driven workflows: Ingestion V2, Chat V5, Audit              │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────────────┐
│                           DATA & AI LAYER                                    │
├─────────────────┬─────────────────┬─────────────────┬────────────────────────┤
│ Paperless-ngx   │ Qdrant (6333)   │ Ollama (11434)  │ Docling (5001)         │
│ (8000)          │ Vector DB       │ LLM Inference   │ PDF Parsing            │
│ Document Mgmt   │ Hybrid Search   │ nomic-embed     │ Structure Preserve     │
│ OCR + Archival  │ BM25 + Dense    │ qwen3:8b     │ Tables/Headers         │
└─────────────────┴─────────────────┴─────────────────┴────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────────────────┐
│                           PERSISTENCE LAYER                                  │
├─────────────────┬─────────────────┬──────────────────────────────────────────┤
│ PostgreSQL x3   │ Redis (6379)    │ Docker Volumes                           │
│ - chatui        │ Session Cache   │ Persistent Storage                       │
│ - paperless     │ 30-day TTL      │                                          │
│ - n8n           │                 │                                          │
└─────────────────┴─────────────────┴──────────────────────────────────────────┘
```

---

## Technology Stack

### Core Services

| Component | Technology | Purpose |
|-----------|------------|---------|
| Document Management | Paperless-ngx | OCR, PDF/A archival, tagging, intake automation |
| Vector Database | Qdrant v1.16.2 | Hybrid search (dense + BM25 sparse) |
| Workflow Engine | n8n 2.4.4 | Document ingestion, chat orchestration, audit |
| LLM Runtime | Ollama (native) | Local inference, no external API calls |
| PDF Parser | Docling (native) | High-fidelity structure extraction |
| Frontend | Express.js + React | Chat interface, admin tools |
| Monitoring | Custom Dashboard | Real-time health, metrics, alerts |

### Database Stack

| Database | Instance | Schema |
|----------|----------|--------|
| PostgreSQL 17.2 | matterdb-chatui | users, sessions, conversations, messages, audit |
| PostgreSQL 17.2 | matterdb-paperless | Paperless internal schema |
| PostgreSQL 17.2 | matterdb-n8n | Workflow execution history |
| Redis 7.4.2 | mattercache | Session tokens, real-time cache |

### AI/ML Models

| Model | Dimensions | Purpose |
|-------|------------|---------|
| bge-m3 | 1024-dim | Dense semantic embeddings |
| qwen3:8b | - | Response generation, reranking |
| Qwen3-Reranker | 0.6B params | Cross-encoder relevance scoring |

---

## Data Flow

### Document Ingestion Pipeline (V2)

```
./intake/<family>/document.pdf
        │
        ▼
┌───────────────────┐
│ Paperless-ngx     │ ← Auto-watch (10s polling)
│ - OCR             │
│ - PDF/A convert   │
│ - Auto-tag family │
└────────┬──────────┘
         │ Webhook: document_added
         ▼
┌───────────────────┐
│ n8n Ingestion V2  │
│ - Download PDF    │
│ - Send to Docling │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Docling           │
│ - Async convert   │
│ - Markdown output │
│ - Table preserve  │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Chunking          │
│ - Parent/child    │
│ - Header-based    │
│ - Context refs    │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Ollama Embed      │
│ - Dense: 1024-dim │
│ - Sparse: BM25    │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Qdrant Upsert     │
│ - Point ID scheme │
│ - Payload metadata│
└───────────────────┘
```

**Point ID Scheme**: `document_id * 10000 + chunk_index` (supports 10,000 chunks/document)

### Chat Query Pipeline (V5)

```
User Question + Family Selection
        │
        ▼
┌───────────────────┐
│ Chat-UI API       │
│ - Auth validation │
│ - Rate limiting   │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ n8n Chat V5       │
│ - Conversation    │
│ - History (10 msg)│
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Hybrid Search     │
│ - Dense: cosine   │
│ - Sparse: BM25    │
│ - RRF fusion      │
│ - Family filter   │
│ - Top 25 results  │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Cross-Encoder     │
│ - Rerank 25 → 5   │
│ - Score: 0-10     │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ LLM Generation    │
│ - System prompt   │
│ - Context + Hist  │
│ - Citation format │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Audit + Response  │
│ - Log to Postgres │
│ - Return JSON     │
└───────────────────┘
```

---

## API Endpoints

### Chat-UI API (Port 3007)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auth/login` | POST | Paperless credential validation |
| `/api/auth/refresh` | POST | JWT refresh token rotation |
| `/api/auth/logout` | POST | Session invalidation |
| `/api/chat` | POST | Send message (proxies to n8n) |
| `/api/conversations` | GET | List user conversations |
| `/api/conversations/:id` | GET | Conversation messages |
| `/api/conversations/:id` | DELETE | Delete conversation |
| `/api/families` | GET | List available families |
| `/api/audit` | POST | Export audit logs (admin only) |

### n8n Webhook Endpoints (Port 5678)

| Endpoint | Trigger |
|----------|---------|
| `/webhook/document-added` | Paperless document_added |
| `/webhook/chat-api-v3` | Chat-UI message submission |

### Qdrant API (Port 6333)

| Operation | Endpoint |
|-----------|----------|
| Collection info | `GET /collections/mattervault_documents` |
| Search | `POST /collections/mattervault_documents/points/query` |
| Upsert | `PUT /collections/mattervault_documents/points` |
| Delete | `DELETE /collections/mattervault_documents/points` |

---

## Database Schema

### Audit Logging (Partitioned)

```sql
CREATE TABLE audit.chat_query_logs (
    id UUID PRIMARY KEY,
    correlation_id UUID NOT NULL,
    n8n_execution_id TEXT,
    user_id UUID,
    paperless_username TEXT NOT NULL,
    client_ip INET,
    user_agent TEXT,
    family_id TEXT NOT NULL,
    conversation_id UUID,
    query_text TEXT NOT NULL,
    response_text TEXT,
    documents_retrieved JSONB,  -- All 25 search results
    documents_cited JSONB,      -- Parsed from response
    total_latency_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Immutability trigger prevents UPDATE/DELETE
-- Monthly partitions: 2026-01 through 2027-12
```

### Vector Payload Schema

```json
{
  "family_id": "morrison",
  "document_id": 42,
  "document_title": "Morrison Family Trust 2024",
  "page_num": 3,
  "chunk_index": 7,
  "text": "The Trustee shall distribute...",
  "context_text": "Article IV: Distribution Provisions"
}
```

---

## Security Architecture

### Data Sovereignty

- **Air-gapped AI**: Ollama runs locally, no OpenAI/Anthropic API calls
- **No cloud storage**: All documents remain on-premises
- **Network isolation**: Docker bridge network, no external egress required

### Authentication Flow

```
User Credentials → Paperless Token API → JWT Generation → Redis Session Cache
                                              │
                                              ▼
                                    Refresh Token (SHA-256 hashed)
                                    Stored in PostgreSQL sessions table
```

- JWT expiry: 24 hours (30 days with "remember me")
- Refresh token rotation on each use
- Session caching in Redis with 30-day TTL

### Access Control

| Role | Capabilities |
|------|--------------|
| admin | All families, audit export, system access |
| user | All families (open access model), own conversations |

Role synced from Paperless superuser status on each login.

### Audit Compliance

- **Immutable logs**: Database triggers prevent UPDATE/DELETE
- **7-year retention**: Monthly JSONL archival
- **Full provenance**: correlation_id links request through entire pipeline
- **Document tracking**: Both retrieved and cited documents logged

---

## Deployment

### Container Topology

```yaml
services:
  mattervault:       # Paperless-ngx
  matterlogic:       # n8n
  mattermemory:      # Qdrant
  mattercache:       # Redis
  matterdb-chatui:   # PostgreSQL (Chat-UI)
  matterdb-paperless: # PostgreSQL (Paperless)
  matterdb-n8n:      # PostgreSQL (n8n)
  matterchat:  # Chat-UI
  matterdash: # Health monitoring

# Native services (Windows host):
  ollama:            # Port 11434
  docling:           # Port 5001
```

### Network

- **matternet**: Docker bridge network
- Internal DNS resolution via container names
- Only ports 3006, 3007, 8000 exposed to host

### Volume Mounts

| Volume | Purpose |
|--------|---------|
| `./paperless/data` | Document storage |
| `./paperless/media` | PDF library |
| `./intake` | Document drop-off folders |
| `./qdrant_data` | Vector database |
| `./chat-ui/data` | Frontend configuration |

---

## Integration Points

### Paperless-ngx Webhooks

```json
{
  "url": "http://matterlogic:5678/webhook/document-added",
  "trigger_on_document_added": true,
  "enabled": true
}
```

### Ollama Configuration

```bash
OLLAMA_HOST=0.0.0.0  # Required for Docker access on Windows
OLLAMA_MODELS=bge-m3,qwen3:8b
```

### Docling API

```
POST /v1/convert/file/async
Content-Type: multipart/form-data

Response: { "task_id": "abc123" }

GET /v1/status/poll/{task_id}
Response: { "status": "completed", "result": "# Markdown..." }
```

---

## Health Monitoring

### Dashboard Features (Port 3006)

- Real-time service status (12 services)
- Response time sparklines (24-hour)
- Vector count metrics
- Alert history with recovery detection
- WebSocket push updates (30s interval)

### Monitored Services

| Service | Health Check |
|---------|--------------|
| Paperless | `GET /api/` |
| n8n | `GET /healthz` |
| Qdrant | `GET /collections` |
| Ollama | `GET /api/tags` |
| Docling | `GET /health` |
| Redis | `PING` |
| PostgreSQL x3 | `SELECT 1` |
| Chat-UI | `GET /api/health` |

---

## Performance Considerations

### Search Pipeline

- Hybrid search retrieves top 25 candidates
- Cross-encoder reranks to top 5
- Total latency: typically 2-5 seconds

### Document Processing

- Docling timeout: 300s (large PDFs may require adjustment)
- Recommended max: 50 pages per PDF
- OCR adds ~2-3s per page for scanned documents

### Scaling Notes

- Qdrant supports distributed mode for larger collections
- n8n workflows can be parallelized
- PostgreSQL partitioning handles audit log growth

---

## Configuration Reference

### Environment Variables

```bash
# Authentication
JWT_SECRET=<production-secret>
PAPERLESS_ADMIN_USER=admin
PAPERLESS_ADMIN_PASS=<secure-password>

# AI Configuration
OLLAMA_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen3:8b
CHAT_HISTORY_LIMIT=10

# Database
CHATUI_DB_PASS=<secure-password>
PAPERLESS_DB_PASS=<secure-password>
N8N_DB_PASS=<secure-password>
```

### Key Files

| Path | Purpose |
|------|---------|
| `docker-compose.yml` | Container orchestration |
| `chat-ui/src/config.js` | API configuration |
| `chat-ui/migrations/*.sql` | Database schema |
| `n8n-workflows/*.json` | Workflow definitions |
| `scripts/health-check.sh` | Service verification |

---

## Troubleshooting

### Common Issues

| Symptom | Likely Cause | Resolution |
|---------|--------------|------------|
| Chat returns no results | Family filter mismatch | Verify document tags in Paperless |
| Ingestion stuck | Docling timeout | Check PDF size, restart Docling |
| Auth failures | Paperless token expired | Restart Paperless, clear Redis |
| Slow searches | Cold Qdrant cache | First query warms cache |

### Diagnostic Commands

```bash
# Check all services
./scripts/health-check.sh

# Qdrant collection info
curl http://localhost:6333/collections/mattervault_documents

# n8n workflow status
curl http://localhost:5678/healthz

# Redis session count
redis-cli -p 6379 KEYS "session:*" | wc -l
```

---

## Future Roadmap

- Per-family access control (restrict users to specific families)
- TLS termination with reverse proxy
- Email alerting for service failures
- Document change/delete synchronization
- Named Entity Recognition for PII redaction
- Legal-specific fine-tuned models

---

**Document maintained by**: Mattervault Development Team
**Last updated**: February 2026
