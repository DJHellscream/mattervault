# Document Sync - Integration Test Checklist

Run these tests after deploying the document sync feature.

## Prerequisites

1. Docker stack is running (`docker compose up -d`)
2. Native services running (Ollama, Docling)
3. At least one document already ingested

## Step 1: Apply Database Migration

```bash
docker exec -i mattervault-db-chatui psql -U chatui chatui < chat-ui/migrations/005_sync_schema.sql
```

**Verify:**
```bash
docker exec mattervault-db-chatui psql -U chatui chatui -c "SELECT * FROM sync.reconciliation_state LIMIT 1;"
```
Expected: Empty result (no error)

## Step 2: Import n8n Workflows

```bash
# Import updated ingestion workflow (with delete step)
docker cp n8n-workflows/document-ingestion-v2.json matterlogic:/tmp/
docker exec matterlogic n8n import:workflow --input=/tmp/document-ingestion-v2.json

# Import new reconciliation workflow
docker cp n8n-workflows/document-reconciliation.json matterlogic:/tmp/
docker exec matterlogic n8n import:workflow --input=/tmp/document-reconciliation.json

# Restart n8n to pick up changes
docker restart matterlogic
```

**Verify:**
- Go to http://localhost:5678
- Check "Document Ingestion Pipeline V2 (Hybrid)" has "Delete Existing Chunks" node
- Check "Document Reconciliation (Sync)" workflow exists

## Step 3: Configure Paperless Workflow

Follow instructions in `docs/paperless-workflow-setup.md`:

1. Go to http://localhost:8000/admin/
2. Create "Sync - Document Updated" workflow
3. Trigger: Document Updated
4. Action: Webhook POST to `http://matterlogic:5678/webhook/document-added-v2`

## Step 4: Test Idempotent Re-ingestion

```bash
# Get current vector count
curl -s http://localhost:6333/collections/mattervault_documents_v2 | jq '.result.points_count'

# Get a document ID from Paperless
PAPERLESS_TOKEN=$(curl -s http://localhost:8000/api/token/ \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r '.token')

DOC_ID=$(curl -s http://localhost:8000/api/documents/ \
  -H "Authorization: Token $PAPERLESS_TOKEN" | jq -r '.results[0].id')

# Trigger re-ingestion
curl -X POST http://localhost:5678/webhook/document-added-v2 \
  -H "Content-Type: application/json" \
  -d "{\"doc_url\":\"http://paperless:8000/api/documents/$DOC_ID/\"}"

# Wait 30 seconds, then check count again
sleep 30
curl -s http://localhost:6333/collections/mattervault_documents_v2 | jq '.result.points_count'
```

**Expected:** Vector count should be the same (no duplicates)

## Step 5: Test Reconciliation Workflow

Manually trigger the reconciliation workflow in n8n:
1. Go to http://localhost:5678
2. Open "Document Reconciliation (Sync)"
3. Click "Execute Workflow"

**Verify:**
```bash
docker exec mattervault-db-chatui psql -U chatui chatui -c \
  "SELECT id, sync_type, status, documents_checked, documents_deleted, documents_ingested FROM sync.reconciliation_state ORDER BY started_at DESC LIMIT 1;"
```

Expected: A row with `status = 'success'`

## Step 6: Test Delete Detection

1. Note the current vector count
2. Delete a document in Paperless (move to trash, then empty trash)
3. Wait for reconciliation (or trigger manually)
4. Check vector count - should decrease

## Step 7: Run E2E Sync Tests

```bash
docker exec e2e-runner /e2e/test.sh sync
```

**Expected:** All tests pass

## Step 8: Full E2E Test

```bash
docker exec e2e-runner /e2e/test.sh full
```

**Expected:** All tests pass, including existing chat tests

---

## Success Criteria

- [ ] Migration applied without errors
- [ ] Both workflows imported and visible in n8n
- [ ] Paperless "Document Updated" workflow configured
- [ ] Re-ingestion is idempotent (no duplicates)
- [ ] Reconciliation workflow runs successfully
- [ ] Delete detection works (orphans removed)
- [ ] E2E sync tests pass
- [ ] Full E2E tests pass
