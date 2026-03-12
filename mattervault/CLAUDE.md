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
| **Chat-UI** | `matterchat` | `3007` | Web frontend + API layer |
| **Health Dashboard** | `matterdash` | `3006` | System monitoring |
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
PDF/Audio dropped in ./intake/<family>/
        │
        ▼
┌───────────────┐
│  Paperless    │ OCR + store PDF/A + auto-tag by folder
│  (webhook)    │────────────────────────────────────────┐
└───────────────┘                                        │
                                                         ▼
                                              ┌──────────────────┐
                                              │  n8n Ingestion   │
                                              │  Workflow        │
                                              └────────┬─────────┘
                                                       │
                    ┌──────────────────────────────────┼──────────────────────────────────┐
                    │                                  │                                  │
                    ▼                                  ▼                                  ▼
           ┌───────────────┐                 ┌───────────────┐                 ┌───────────────┐
           │   Docling     │                 │    Ollama     │                 │    Qdrant     │
           │  (parse PDF)  │────────────────▶│  (embed)      │────────────────▶│  (store)      │
           │  → Markdown   │                 │  bge-m3       │                 │  dense + BM25 │
           └───────────────┘                 └───────────────┘                 └───────────────┘
```

**Audio Support**: Voice memos and audio recordings (WAV, MP3, M4A) are transcribed via Docling's Whisper ASR integration before embedding. Requires Docling to be started with ASR support: `docling-serve --host 0.0.0.0 --port 5001 --no-ui --asr`

**Ingestion Status Tags**: Documents are tagged through the pipeline for visibility:
- `intake` → `processing` (ingestion starts) → `ai_ready` (success) or `ingestion_error` (failure)
- `intake` and `processing` tags are removed on success
- Paralegals can filter by tag in Paperless to see stuck documents

### Chat Query Flow

```
User Question (Chat-UI)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    n8n Chat Workflow                                   │
├───────────────────────────────────────────────────────────────────────┤
│  1. Get/Create Conversation (Postgres)                                 │
│  2. Save User Message (Postgres)                                       │
│  3. Get Chat History (last 10 messages)                               │
│  4. Embed Question (Ollama → 1024-dim vector)                         │
│  5. Generate BM25 Sparse Vector (hashCode tokenizer)                  │
│  6. Hybrid Search (Qdrant RRF fusion, filtered by family_id)          │
│  7. Keyword Pre-Filter (boost exact matches)                          │
│  8. LLM Reranker (qwen3:8b scores 0-10)                                 │
│  9. Build Prompt (top results + chat history)                         │
│ 10. Generate Answer (qwen3:8b)                                           │
│ 11. Extract Citations                                                  │
│ 12. Save Assistant Message (Postgres)                                  │
│ 13. Log Audit (audit.chat_query_logs)                                 │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
Response with Citations → Chat-UI → User
```

### Citation Linking

Chat responses include clickable citations that link directly to source documents:

- **Page-level precision**: Citations show document title and page number (e.g., "Morrison Trust 2024, p.4")
- **In-app PDF viewer**: Clicking a citation opens the PDF within Chat-UI (no context switch to Paperless)
- **Document proxy**: Chat-UI proxies PDF requests through Paperless API with user's auth token
- **Verification workflow**: Attorneys can immediately verify AI answers against source material

Example citation in response:
```
The trust was executed on March 15, 2024 [Morrison Trust 2024, p.4]
                                          ^^^^^^^^^^^^^^^^^^^^^^^^
                                          Click → PDF viewer opens to page 4
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

Data isolation is enforced at query time via `family_id` filter. The Qdrant `family_id` index uses `is_tenant: true` for optimized per-family disk I/O (Qdrant v1.11+).

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
2. **Pre-Consume Validation**: `pre-consume-validate.sh` rejects docs from unrecognized folders (no matching Paperless tag)
3. **Paperless**: `PAPERLESS_CONSUMER_SUBDIRS_AS_TAGS=true` auto-tags by folder
4. **Ingestion**: n8n extracts family tag → stores as `family_id`
5. **Chat**: User selects family → all queries filtered by `family_id`
6. **Reconciliation**: Detects and corrects family_id mismatches (e.g., after tag rename)

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
| Family Tag Renamed | Reconciliation | ≤15 min |

### How It Works

1. **Real-time**: Paperless workflows trigger n8n webhooks for adds/updates
2. **Idempotent Ingestion**: Every ingestion deletes existing chunks first (safe to re-run)
3. **Scheduled Reconciliation**: Every 15 minutes, compares Paperless vs Qdrant
   - Deletes orphans (in Qdrant, not in Paperless)
   - Ingests missing (in Paperless, not in Qdrant)
   - Fixes family_id mismatches (Qdrant payload update + ChatUI conversations update, no re-embedding)
4. **Weekly Full Scan**: Sunday 2 AM, full comparison regardless of timestamps
5. **Manual Trigger**: "Reconcile Now" button on dashboard or POST to `/webhook/document-reconciliation`

### Configuration

Sync schedules are configured directly in the n8n "Document Reconciliation (Sync)" workflow:
- **Interval**: Edit the Schedule Trigger node (default: 15 minutes)
- **Full Scan**: Edit the cron expression (default: Sunday 2 AM)

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
| Family tag renamed, old name in chat | Wait for reconciliation or click "Reconcile Now" on dashboard |
| Doc rejected from intake folder | Create matching tag in Paperless first (pre-consume validation) |

## 8. n8n Workflows

### Active Workflows

| Workflow | ID | Purpose |
|----------|-----|---------|
| Document Ingestion Pipeline | `ZIhqLsxBzrUam8bi` | Ingest PDFs → Qdrant |
| Mattervault Chat | `wHoLnYdlFJoaHfDZ` | Chat API with history + audit |
| Audit Partition Maintenance | `SPDqGNXbYC6J4aKX` | Monthly partition creation |
| Audit Archive (7-Year Retention) | `GkM7qDYrqrAQeAyv` | Archive old data |
| Document Reconciliation (Sync) | `qmC66Y7q2qYPOfN6` | Scheduled sync + delete detection |
| System Alerts (Email) | `UWdvsIE47cPS6G0l` | Alert notifications via SMTP |

### Workflow Files

| File | Workflow |
|------|----------|
| `document-ingestion.json` | Document Ingestion Pipeline |
| `mattervault-chat.json` | Mattervault Chat |
| `document-reconciliation.json` | Document Reconciliation (Sync) |
| `audit-partition-maintenance.json` | Audit Partition Maintenance |
| `audit-archive.json` | Audit Archive (7-Year Retention) |
| `system-alerts.json` | System Alerts (Email) - optional |

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

| Purpose | Model | Env Variable | Dimensions |
|---------|-------|-------------|------------|
| Embeddings | `bge-m3` | `OLLAMA_EMBEDDING_MODEL` | 1024 |
| Chat/Generation | `qwen3:8b` | `OLLAMA_CHAT_MODEL` | - |
| Reranking | `qwen3:8b` | `OLLAMA_RERANKER_MODEL` | - |

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

The health dashboard (`matterdash:3006`) monitors all services.

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

### Alerting

The dashboard sends alerts via webhook to n8n, which handles email delivery.

**Alert Flow:**
```
Dashboard detects issue → POST to n8n webhook → n8n sends email
```

**Built-in Alert Rules:**
| Rule | Severity | Condition |
|------|----------|-----------|
| Service Down | Critical | Any service status = down |
| Qdrant Empty | Critical | Vector count = 0 |
| Paperless Empty | Warning | Document count = 0 |
| ChatUI DB Down | Critical | Database connection failed |
| ChatUI Redis Down | Warning | Redis connection failed |
| High Redis Memory | Warning | Memory > 500MB |

**Setup Email Alerts:**

1. Import the System Alerts workflow in n8n:
   ```bash
   docker cp n8n-workflows/system-alerts.json matterlogic:/tmp/
   docker exec matterlogic n8n import:workflow --input=/tmp/system-alerts.json
   docker restart matterlogic
   ```

2. Configure SMTP credentials in n8n UI (Settings → Credentials → Add SMTP)

3. Set environment variables in n8n:
   - `ALERT_TO_EMAIL` - recipient email address
   - `ALERT_FROM_EMAIL` - sender email address

4. Activate the "System Alerts (Email)" workflow in n8n

**Cooldown:** Alerts are rate-limited to prevent spam (default: 5 minutes per rule/service).

## 12. Configuration

All configuration lives in `.env`. New deployment = `cp .env.example .env` + edit values + `docker compose up -d` + `./scripts/init-mattervault.sh`.

### Key Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MATTERVAULT_DATA_DIR` | `.` | Base path for all volume mounts (Windows: `D:\CCC\mattervault`) |
| `OLLAMA_CHAT_MODEL` | `qwen3:8b` | LLM for chat and reranking |
| `OLLAMA_EMBEDDING_MODEL` | `bge-m3` | Embedding model |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama API endpoint |
| `DOCLING_URL` | `http://host.docker.internal:5001` | Docling API endpoint |
| `QDRANT_URL` | `http://mattermemory:6333` | Qdrant internal URL |
| `QDRANT_COLLECTION` | `mattervault_documents` | Qdrant collection name |
| `PAPERLESS_INTERNAL_URL` | `http://mattervault:8000` | Paperless internal URL |
| `N8N_INTERNAL_URL` | `http://matterlogic:5678` | n8n internal URL |

Service URLs and model names are passed to n8n (for workflow `$env.*` expressions) and the dashboard via `docker-compose.yml`. Database passwords are in `.env` and referenced with `${VAR:-default}` syntax.

## 13. Development

### Fresh Installation

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env: set passwords, MATTERVAULT_DATA_DIR (if not current directory)

# 2. Start native services (host machine)
# Windows:  $env:OLLAMA_HOST="0.0.0.0"; ollama serve
# Mac/Linux: OLLAMA_HOST=0.0.0.0 ollama serve
# Docling:  docling-serve --host 0.0.0.0 --port 5001 --no-ui --asr

# 3. Pull AI models
ollama pull qwen3:8b
ollama pull bge-m3

# 4. Start Docker services
docker compose up -d

# 5. Run initialization script (creates Qdrant collection, imports n8n workflows, creates Paperless webhooks)
./scripts/init-mattervault.sh

# 6. Create intake folders for your families
mkdir -p ./intake/smith ./intake/jones
```

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

The E2E test runner lives in a separate compose file (`docker-compose.test.yml`) to keep the main stack clean.

```bash
# Start the test container
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d mattertest

# Full test suite (reset + ingest + chat tests)
docker exec mattertest /e2e/test.sh full

# Quick test (use existing data)
docker exec mattertest /e2e/test.sh test

# Document sync tests
docker exec mattertest /e2e/test.sh sync

# Audit system tests
docker exec mattertest /e2e/test.sh audit

# Embedding validation tests
docker exec mattertest /e2e/test.sh embedding

# Audio ingestion tests (requires Docling with --asr)
docker exec mattertest /e2e/test.sh audio

# Complete suite (full + sync + audit + embedding + audio + more)
docker exec mattertest /e2e/test.sh all
```

### Key URLs

| Service | URL |
|---------|-----|
| Chat UI | http://localhost:3007 |
| Health Dashboard | http://localhost:3006 |
| Paperless | http://localhost:8000 |
| n8n | http://localhost:5678 |
| Qdrant | http://localhost:6333/dashboard |

## 14. Security

- NO external API calls for AI (everything local)
- NO cloud storage integrations
- All services on internal Docker network
- `.env` excluded from git via `.gitignore` — never commit secrets
- New deployments: `cp .env.example .env` then edit values
- SQL injection protection via parameterized queries + escaping
- JWT tokens with Redis session validation
- Expired sessions cleaned up automatically (every 24 hours + on startup)

## 15. Known Issues

- Docling timeout set to 10 minutes (600s) for large PDFs; `scripts/split-pdf.py` available for manual splitting of 200+ page documents
- Paperless webhooks require restart after n8n URL change
- Ollama must run with `OLLAMA_HOST=0.0.0.0` on Windows

## 16. Quick Reference

### Container Names

| Service | Container |
|---------|-----------|
| Paperless | `mattervault` |
| n8n | `matterlogic` |
| Qdrant | `mattermemory` |
| Chat-UI | `matterchat` |
| Dashboard | `matterdash` |
| ChatUI DB | `matterdb-chatui` |
| Paperless DB | `matterdb-paperless` |
| n8n DB | `matterdb-n8n` |
| Redis | `mattercache` |
| E2E Runner | `mattertest` |

### Database Schemas

| Database | Tables |
|----------|--------|
| `chatui` | `users`, `sessions`, `conversations`, `messages`, `audit.chat_query_logs` |
| `paperless` | Paperless-ngx tables |
| `n8n` | n8n tables |

### Qdrant Collection

- **Name**: `mattervault_documents`
- **Dense vectors**: 1024 dims, Cosine
- **Sparse vectors**: BM25 with IDF modifier
- **Indexes**: `family_id` (keyword, `is_tenant: true`), `document_id` (keyword)

## 17. Pre-Consume Validation

Paperless calls `scripts/pre-consume-validate.sh` before ingesting any document. This prevents documents from unrecognized intake subfolders from being processed.

### Behavior

| Scenario | Result |
|----------|--------|
| File in `intake/morrison/` + tag "morrison" exists | Allowed |
| File in `intake/newclient/` + no tag "newclient" | **Rejected** (file stays) |
| File uploaded via Paperless UI (not intake/) | Allowed |
| File in root consume folder | Allowed |
| Paperless API unreachable | Allowed (fail open) |

### How It Works

1. Paperless sets `$DOCUMENT_SOURCE_PATH` and calls the script
2. Script normalizes path with `realpath` (Paperless bug #1196 workaround)
3. If not in `intake/*/` pattern → exit 0 (allow)
4. Extracts family name from subfolder
5. Queries `GET /api/tags/?name__iexact=<family>` using `PAPERLESS_ADMIN_PASSWORD`
6. Tag exists → exit 0 (allow); tag missing → exit 1 (reject)

### Configuration

Set in `docker-compose.yml` under `paperless` service:
- `PAPERLESS_PRE_CONSUME_SCRIPT: /usr/src/paperless/scripts/pre-consume-validate.sh`
- Volume mount: `scripts/pre-consume-validate.sh` → `/usr/src/paperless/scripts/pre-consume-validate.sh:ro`
