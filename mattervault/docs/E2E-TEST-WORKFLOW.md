# Mattervault End-to-End Test Workflow

## Quick Start

```bash
# Full test (reset + ingest + test)
./scripts/e2e.sh

# Reset only (clear all data)
./scripts/e2e.sh reset

# Test only (use existing data)
./scripts/e2e.sh test
```

## Prerequisites

Before running E2E tests:

1. **Docker services running:** `docker compose up -d`
2. **Native services running (Windows host):**
   - Ollama: `$env:OLLAMA_HOST="0.0.0.0"; ollama serve`
   - Docling: `docling-serve --host 0.0.0.0 --port 5001 --no-ui`

## How It Works

The E2E test runs **inside a Docker container** on the `matternet` network. This eliminates all networking confusion between WSL, Windows, and Docker.

| What | Hostname (internal) | Port |
|------|---------------------|------|
| Paperless | mattervault | 8000 |
| n8n | matterlogic | 5678 |
| Qdrant | qdrant | 6333 |
| ChatUI DB | matterdb-chatui | 5432 |
| Ollama | host.docker.internal | 11434 |
| Docling | host.docker.internal | 5001 |

## Test Phases

| Phase | What's Tested |
|-------|---------------|
| Health Check | All services responding |
| Reset | Clear Paperless, Qdrant, ChatUI DB |
| Ingestion | Paperless processing, n8n webhook, Qdrant indexing |
| Chat Tests | 4 standard questions against chat API |
| Verification | Audit logs, conversations, vector counts |

## Test Questions

| Question | Expected Pattern |
|----------|-----------------|
| "What are the key events?" | 1972, Harold, Eleanor, marry |
| "What is Harold's address?" | Willowbrook, 8742, Indianapolis |
| "Who are Harold's children?" | David, Katie, Rob |
| "When was Morrison Manufacturing sold?" | 2019, 47 |

## Manual Testing

If you need to run tests manually inside the container:

```bash
# Start the e2e container
docker compose --profile test up -d e2e

# Run tests
docker exec e2e-runner /e2e/test.sh full

# Or interactively
docker exec -it e2e-runner bash
/e2e/test.sh test
```

## Troubleshooting

### Health check fails

```bash
# Check which services are down
docker ps
docker logs mattervault
docker logs matterlogic
```

### Ingestion not working

```bash
# Check Paperless logs
docker logs mattervault -f

# Check n8n executions in UI
# http://localhost:5678
```

### Chat returns errors

```bash
# Check if user exists in ChatUI
docker exec matterdb-chatui psql -U chatui -d chatui -c "SELECT * FROM users"

# Check if vectors exist
curl http://localhost:6333/collections/mattervault_documents_v2
```

## Files

| File | Purpose |
|------|---------|
| `e2e/Dockerfile` | E2E test container |
| `e2e/test.sh` | Main test script (runs inside container) |
| `scripts/e2e.sh` | Convenience wrapper (runs from host) |
