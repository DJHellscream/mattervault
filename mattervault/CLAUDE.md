# Mattervault - Private Document Intelligence System

The 'agent' - You - Claude Code - is a Law Firm Product Architect and understands the workflow of actual Law Firm employees.

## 1. Project Overview

Mattervault is a **private, air-gapped Document Intelligence System** built for legal and estate planning. It ingests PDFs, preserves their structure (tables, headers) using high-fidelity parsing, and enables semantic search and chat ("RAG") without ever sending data to the cloud.

## 2. Architecture Overview

### System Components

| Service | Container | Port | Purpose |
|---------|-----------|------|---------|
| **Paperless-ngx** | `mattervault` | `8000` | Document vault + OCR + user authentication |
| **n8n** | `matterlogic` | `5678` | Workflow orchestration (ingestion + chat) |
| **Qdrant** | `mattermemory` | `6333` | Vector database (hybrid search) |
| **Chat-UI** | `mattervault-chat` | `3007` | Web frontend + API layer |
| **Health Dashboard** | `mattervault-dashboard` | `3006` | System monitoring |
| **PostgreSQL** | `db-paperless`, `db-n8n`, `db-chatui` | `5432` | Databases |
| **Redis** | `redis` | `6379` | Session cache |
| **Ollama** | **Native (Windows)** | `11434` | LLM + embeddings |
| **Docling** | **Native (Windows)** | `5001` | PDF parsing |

### Network Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Docker Network: matternet                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐              │
│   │  Chat-UI    │────▶│    n8n      │────▶│   Qdrant    │              │
│   │   :3007     │     │   :5678     │     │   :6333     │              │
│   └─────────────┘     └─────────────┘     └─────────────┘              │
│          │                   │                                          │
│          │                   │                                          │
│          ▼                   ▼                                          │
│   ┌─────────────┐     ┌─────────────────────────────────┐              │
│   │  Paperless  │     │     host.docker.internal        │              │
│   │   :8000     │     │  ┌─────────┐    ┌─────────┐     │              │
│   │  (auth)     │     │  │ Ollama  │    │ Docling │     │              │
│   └─────────────┘     │  │ :11434  │    │ :5001   │     │              │
│                       │  └─────────┘    └─────────┘     │              │
│                       └─────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────────┘
```

## 3. Data Flow

### Document Ingestion Pipeline

```
PDF dropped in ./intake/<family>/
        │
        ▼
┌───────────────┐
│  Paperless    │ OCR + store PDF/A + auto-tag by folder
│  (webhook)    │────────────────────────────────────────┐
└───────────────┘                                        │
                                                         ▼
                                              ┌──────────────────┐
                                              │  n8n Ingestion   │
                                              │  Workflow V2     │
                                              └────────┬─────────┘
                                                       │
                    ┌──────────────────────────────────┼──────────────────────────────────┐
                    │                                  │                                  │
                    ▼                                  ▼                                  ▼
           ┌───────────────┐                 ┌───────────────┐                 ┌───────────────┐
           │   Docling     │                 │    Ollama     │                 │    Qdrant     │
           │  (parse PDF)  │────────────────▶│  (embed)      │────────────────▶│  (store)      │
           │  → Markdown   │                 │  nomic-embed  │                 │  dense + BM25 │
           └───────────────┘                 └───────────────┘                 └───────────────┘
```

### Chat Query Flow (V5)

```
User Question (Chat-UI)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    n8n Chat Workflow V5                                │
├───────────────────────────────────────────────────────────────────────┤
│  1. Get/Create Conversation (Postgres)                                 │
│  2. Save User Message (Postgres)                                       │
│  3. Get Chat History (last 10 messages)                               │
│  4. Embed Question (Ollama → 768-dim vector)                          │
│  5. Generate BM25 Sparse Vector (hashCode tokenizer)                  │
│  6. Hybrid Search (Qdrant RRF fusion, filtered by family_id)          │
│  7. Keyword Pre-Filter (boost exact matches)                          │
│  8. LLM Reranker (llama3.1:8b scores 0-10)                           │
│  9. Build Prompt (top results + chat history)                         │
│ 10. Generate Answer (llama3.1:8b)                                     │
│ 11. Extract Citations                                                  │
│ 12. Save Assistant Message (Postgres)                                  │
│ 13. Log Audit (audit.chat_query_logs)                                 │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
Response with Citations → Chat-UI → User
```

## 4. Authentication

**Paperless-ngx is the identity provider.** Users authenticate with their Paperless credentials.

### Auth Flow

1. User submits username/password to Chat-UI
2. Chat-UI validates against Paperless `/api/token/`
3. On success: JWT issued, user record synced to `chatui` database
4. Session stored in Redis with refresh token
5. Family selection is per-conversation (open access model)

### JWT Payload

```json
{
  "userId": "uuid",
  "paperlessUserId": 3,
  "paperlessUsername": "jsmith",
  "role": "user",
  "displayName": "John Smith"
}
```

### Access Model

**Open access**: Any authenticated Paperless user can query any family's documents. Family is selected per-conversation via dropdown. This is appropriate for small, trusted teams.

## 5. Multi-Tenancy (Family Isolation)

Data isolation is enforced at query time via `family_id` filter.

### Qdrant Payload Schema

```json
{
  "family_id": "morrison",
  "text": "chunk text",
  "context_text": "parent text for retrieval",
  "document_id": "paperless_123",
  "document_title": "Morrison Trust 2024",
  "page_num": 4,
  "chunk_index": 12
}
```

### Family ID Flow

1. **Intake**: Subfolders per family (`./intake/morrison/`, `./intake/johnson/`)
2. **Paperless**: `PAPERLESS_CONSUMER_SUBDIRS_AS_TAGS=true` auto-tags by folder
3. **Ingestion**: n8n extracts family tag → stores as `family_id`
4. **Chat**: User selects family → all queries filtered by `family_id`

## 6. Audit Logging

Every chat query is logged with 7-year retention for compliance.

### Logged Fields

| Field | Description |
|-------|-------------|
| `correlation_id` | UUID linking request through n8n |
| `user_id`, `paperless_username` | Who made the query |
| `family_id` | Which family's documents |
| `query_text` | The user's question |
| `response_text` | The LLM's answer |
| `documents_retrieved` | All docs from Qdrant search |
| `documents_cited` | Docs cited in the answer |
| `total_latency_ms` | End-to-end request time |
| `n8n_execution_id` | n8n execution for debugging |

### Audit API (Admin Only)

```bash
# Export audit logs as JSONL (max 1 year range)
GET /api/audit/export?start_date=2026-01-01&end_date=2026-02-01

# Summary statistics
GET /api/audit/summary?group_by=user    # or 'family' or 'month'

# Single query lookup
GET /api/audit/query/:correlationId
```

### Maintenance Workflows (n8n timers)

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| Audit Partition Maintenance | Monthly | Create future partitions |
| Audit Archive (7-Year) | Monthly | Archive old partitions to JSONL |

## 7. Document Sync

MatterVault keeps Qdrant vectors synchronized with Paperless using a hybrid approach.

### Sync Methods

| Event | Method | Latency |
|-------|--------|---------|
| Document Added | Webhook | Instant |
| Document Updated | Webhook | Instant |
| Document Deleted | Reconciliation | ≤15 min |

### How It Works

1. **Real-time**: Paperless workflows trigger n8n webhooks for adds/updates
2. **Idempotent Ingestion**: Every ingestion deletes existing chunks first (safe to re-run)
3. **Scheduled Reconciliation**: Every 15 minutes, compares Paperless vs Qdrant
   - Deletes orphans (in Qdrant, not in Paperless)
   - Ingests missing (in Paperless, not in Qdrant)
4. **Weekly Full Scan**: Sunday 2 AM, full comparison regardless of timestamps

### Configuration

```bash
# .env
SYNC_RECONCILIATION_INTERVAL_MINUTES=15  # How often to check for deletes
SYNC_FULL_SCAN_CRON=0 2 * * 0            # Weekly full scan schedule
SYNC_FALLBACK_WINDOW_HOURS=2             # Fallback if no high-water mark
```

### Monitoring

```sql
-- Recent reconciliation runs
SELECT * FROM sync.reconciliation_state ORDER BY started_at DESC LIMIT 10;

-- Operations log
SELECT * FROM sync.reconciliation_log WHERE created_at > NOW() - INTERVAL '1 day';
```

### Troubleshooting

| Issue | Check |
|-------|-------|
| Document not syncing | Paperless workflow enabled? Check n8n executions |
| Deleted doc still in chat | Wait for reconciliation or trigger manually |
| Duplicates in Qdrant | Check delete step in ingestion workflow |

## 8. n8n Workflows

### Active Workflows

| Workflow | ID | Purpose |
|----------|-----|---------|
| Document Ingestion Pipeline V2 (Hybrid) | `ZIhqLsxBzrUam8bi` | Ingest PDFs → Qdrant |
| Mattervault Chat V5 (With Persistence) | `wHoLnYdlFJoaHfDZ` | Chat API with history + audit |
| Audit Partition Maintenance | `SPDqGNXbYC6J4aKX` | Monthly partition creation |
| Audit Archive (7-Year Retention) | `GkM7qDYrqrAQeAyv` | Archive old data |
| Document Reconciliation (Sync) | `qmC66Y7q2qYPOfN6` | Scheduled sync + delete detection |

### Updating Workflows

```bash
# List workflows
docker exec matterlogic n8n list:workflow --active=true

# Export (to get current ID)
docker exec matterlogic n8n export:workflow --id=<ID> --output=/tmp/workflow.json
docker cp matterlogic:/tmp/workflow.json ./n8n-workflows/

# Import (KEEP the id field to update, not duplicate)
docker cp ./n8n-workflows/my-workflow.json matterlogic:/tmp/
docker exec matterlogic n8n import:workflow --input=/tmp/my-workflow.json
docker restart matterlogic
```

**Critical**: Never remove or change the `"id"` field in workflow JSON files.

## 9. Models

| Purpose | Model | Dimensions |
|---------|-------|------------|
| Embeddings | `nomic-embed-text` | 768 |
| Chat/Generation | `llama3.1:8b` | - |
| Reranking | `llama3.1:8b` | - |

## 10. File Structure

```
/mattervault
├── docker-compose.yml          # All Docker services
├── .env                        # Secrets (never commit)
├── CLAUDE.md                   # This file
├── /chat-ui                    # Express frontend + API
│   ├── /src
│   │   ├── index.js            # Main server
│   │   ├── auth.js             # Paperless auth
│   │   ├── streaming.js        # SSE chat endpoint
│   │   ├── auditLogger.js      # Audit logging
│   │   ├── /routes
│   │   │   ├── auth.js         # Login/logout/refresh
│   │   │   ├── audit.js        # Admin audit endpoints
│   │   │   ├── conversations.js
│   │   │   └── documents.js    # PDF proxy
│   │   └── /middleware
│   │       └── auth.js         # JWT verification
│   ├── /migrations             # SQL migrations
│   └── /public                 # Static frontend
├── /n8n-workflows              # Workflow JSON exports
├── /intake                     # Watched folder
│   ├── /morrison
│   └── /johnson
├── /scripts                    # Utility scripts
├── /e2e                        # E2E test suite
└── /paperless                  # Paperless volumes
```

## 11. Health Dashboard

The health dashboard (`mattervault-dashboard:3006`) monitors all services.

### Features

- Real-time WebSocket updates
- Service cards grouped by type (Core, Databases, Support)
- Metrics summary (vectors, documents, conversations, messages)
- Family distribution breakdown
- Alert history with severity levels
- 24-hour timeline per service

### API Endpoints

```bash
GET /api/status          # All services
GET /api/status/:id      # Single service with history
GET /api/metrics         # All metrics with summary
GET /api/alerts          # Recent alerts
WebSocket /ws            # Real-time updates
```

## 12. Development

### Starting Services

```bash
# Native services (Windows PowerShell)
.\scripts\start-native.ps1

# Docker services
docker compose up -d

# Health check
./scripts/health-check.sh
```

### E2E Testing

```bash
# Full test suite (reset + ingest + chat tests)
docker exec e2e-runner /e2e/test.sh full

# Quick test (use existing data)
docker exec e2e-runner /e2e/test.sh test

# Document sync tests
docker exec e2e-runner /e2e/test.sh sync

# Audit system tests
docker exec e2e-runner /e2e/test.sh audit

# Complete suite (full + sync + audit)
docker exec e2e-runner /e2e/test.sh all
```

### Key URLs

| Service | URL |
|---------|-----|
| Chat UI | http://localhost:3007 |
| Health Dashboard | http://localhost:3006 |
| Paperless | http://localhost:8000 |
| n8n | http://localhost:5678 |
| Qdrant | http://localhost:6333/dashboard |

## 13. Security

- NO external API calls for AI (everything local)
- NO cloud storage integrations
- All services on internal Docker network
- Sensitive values in `.env`, never committed
- SQL injection protection via parameterized queries + escaping
- JWT tokens with Redis session validation

## 14. Known Issues

- Docling may timeout on PDFs >50 pages
- Paperless webhooks require restart after n8n URL change
- Ollama must run with `OLLAMA_HOST=0.0.0.0` on Windows

## 15. Quick Reference

### Container Names

| Service | Container |
|---------|-----------|
| Paperless | `mattervault` |
| n8n | `matterlogic` |
| Qdrant | `mattermemory` |
| Chat-UI | `mattervault-chat` |
| Dashboard | `mattervault-dashboard` |
| ChatUI DB | `mattervault-db-chatui` |

### Database Schemas

| Database | Tables |
|----------|--------|
| `chatui` | `users`, `sessions`, `conversations`, `messages`, `audit.chat_query_logs` |
| `paperless` | Paperless-ngx tables |
| `n8n` | n8n tables |

### Qdrant Collection

- **Name**: `mattervault_documents_v2`
- **Dense vectors**: 768 dims, Cosine
- **Sparse vectors**: BM25 with IDF modifier
