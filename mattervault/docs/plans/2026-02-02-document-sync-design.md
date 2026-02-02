# Document Change/Delete Sync - Design Document

*Created: 2026-02-02*

## Problem

When documents are modified or deleted in Paperless-ngx, the Qdrant vector store becomes stale. Users may get chat answers citing documents that no longer exist or have outdated content.

**Paperless is the source of truth.** Qdrant must mirror it exactly.

## Solution

A hybrid sync system using:
1. **Real-time webhooks** for adds/updates (instant)
2. **Scheduled reconciliation** for deletes and missed events (configurable interval, default 15 min)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         REAL-TIME SYNC                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Paperless Workflow          n8n                         Qdrant        │
│   ┌─────────────────┐        ┌─────────────────┐        ┌───────────┐  │
│   │ Document Added  │───────▶│ Ingestion V2    │───────▶│ Upsert    │  │
│   │ (existing)      │        │ (delete + add)  │        │ Vectors   │  │
│   └─────────────────┘        └─────────────────┘        └───────────┘  │
│                                      ▲                                  │
│   ┌─────────────────┐                │                                  │
│   │ Document Updated│────────────────┘                                  │
│   │ (new workflow)  │                                                   │
│   └─────────────────┘                                                   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                         SCHEDULED SYNC                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   n8n Scheduled Trigger (every 15 min, configurable)                    │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ 1. Read last_sync_timestamp from PostgreSQL                     │  │
│   │ 2. Query Paperless: GET /api/documents/?modified__gt=TS         │  │
│   │ 3. Query Qdrant: Get unique document_ids                        │  │
│   │ 4. Delete orphans (in Qdrant, not in Paperless)                 │  │
│   │ 5. Ingest missing (in Paperless, not in Qdrant)                 │  │
│   │ 6. Update last_sync_timestamp = NOW()                           │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   Weekly Full Scan (Sunday 2 AM)                                        │
│   └─── Compare ALL documents, not just recent ───────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Why This Approach

Paperless-ngx workflow triggers support:
- **Document Added** - already implemented
- **Document Updated** - can add webhook action
- **Document Deleted** - NO TRIGGER EXISTS

Since there's no delete trigger, scheduled reconciliation is required. The hybrid approach gives us instant sync for adds/updates with reconciliation as a safety net.

## Components to Build/Modify

| Component | Type | Change |
|-----------|------|--------|
| **Ingestion Workflow V2** | n8n workflow | Add "delete existing chunks" step at start |
| **Paperless "Document Updated" Workflow** | Paperless config | New workflow trigger → webhook to n8n |
| **Reconciliation Workflow** | n8n workflow (new) | Scheduled sync with high-water mark |
| **Sync State Table** | PostgreSQL | Store last sync timestamp |
| **Environment Config** | docker-compose | Add `SYNC_RECONCILIATION_INTERVAL_MINUTES` |

## Data Flow: Document Updated (Real-time)

```
User edits document in Paperless
         │
         ▼
┌─────────────────────────┐
│ Paperless Workflow      │
│ Trigger: Doc Updated    │
│ Action: Webhook POST    │
└───────────┬─────────────┘
            │ POST /webhook/document-updated-v2
            ▼
┌─────────────────────────┐
│ n8n: Ingestion V2       │
│ 1. Parse document_id    │
│ 2. DELETE from Qdrant   │◄── NEW STEP
│    WHERE doc_id = X     │
│ 3. Fetch doc details    │
│ 4. Download PDF         │
│ 5. Docling parse        │
│ 6. Chunk + embed        │
│ 7. Store in Qdrant      │
└─────────────────────────┘
```

## Data Flow: Reconciliation (Scheduled)

```
Every 15 minutes (configurable via SYNC_RECONCILIATION_INTERVAL_MINUTES)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ n8n: Reconciliation Workflow                                │
├─────────────────────────────────────────────────────────────┤
│ 1. Read last_sync_timestamp from PostgreSQL                 │
│ 2. Query Paperless: GET /api/documents/?modified__gt=TS     │
│ 3. Query Qdrant: Get unique document_ids                    │
│                                                             │
│ 4. FIND ORPHANS:                                            │
│    - Qdrant doc_ids NOT IN Paperless → DELETE from Qdrant   │
│                                                             │
│ 5. FIND MISSING:                                            │
│    - Paperless docs NOT IN Qdrant → Trigger ingestion       │
│                                                             │
│ 6. Update last_sync_timestamp = NOW()                       │
└─────────────────────────────────────────────────────────────┘

Weekly (Sunday 2 AM): Same flow but skip timestamp filter, compare ALL docs
```

## High-Water Mark Tracking

To avoid re-processing the same documents, we track the last successful sync timestamp:

| Run | Query | Result |
|-----|-------|--------|
| Run 1 (10:00) | `modified_after=null` (first run) | Process all, save timestamp `10:00` |
| Run 2 (10:15) | `modified_after=10:00` | Only docs modified since 10:00 |
| Run 3 (10:30) | `modified_after=10:15` | Only docs modified since 10:15 |

If the timestamp is missing or corrupted, fall back to a 2-hour window.

## Database Schema

### Sync State Table

```sql
CREATE SCHEMA IF NOT EXISTS sync;

CREATE TABLE sync.reconciliation_state (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL,  -- 'incremental' or 'full'
    last_run_at TIMESTAMPTZ NOT NULL,
    last_success_at TIMESTAMPTZ,
    documents_checked INT DEFAULT 0,
    documents_deleted INT DEFAULT 0,
    documents_ingested INT DEFAULT 0,
    error_message TEXT
);
```

### Reconciliation Log Table

```sql
CREATE TABLE sync.reconciliation_log (
    id SERIAL PRIMARY KEY,
    run_id UUID NOT NULL,
    operation VARCHAR(20) NOT NULL,  -- 'delete', 'ingest', 'skip'
    document_id VARCHAR(50) NOT NULL,
    document_title TEXT,
    family_id VARCHAR(100),
    status VARCHAR(20) NOT NULL,     -- 'success', 'failed', 'skipped'
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reconciliation_log_run_id ON sync.reconciliation_log(run_id);
CREATE INDEX idx_reconciliation_log_document_id ON sync.reconciliation_log(document_id);
CREATE INDEX idx_reconciliation_log_created_at ON sync.reconciliation_log(created_at);
```

## Configuration

Add to `.env`:

```bash
# Document Sync Configuration
SYNC_RECONCILIATION_INTERVAL_MINUTES=15
SYNC_FULL_SCAN_CRON="0 2 * * 0"  # Sunday 2 AM
SYNC_FALLBACK_WINDOW_HOURS=2
```

Add to `docker-compose.yml` (matterlogic service):

```yaml
environment:
  SYNC_RECONCILIATION_INTERVAL_MINUTES: ${SYNC_RECONCILIATION_INTERVAL_MINUTES:-15}
  SYNC_FULL_SCAN_CRON: ${SYNC_FULL_SCAN_CRON:-0 2 * * 0}
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| **Webhook fails (n8n down)** | Reconciliation catches it within 15 min |
| **Qdrant delete fails** | Retry 3x, then log error and continue (don't block ingestion) |
| **Paperless API timeout** | Retry with exponential backoff, abort run after 3 failures |
| **Document deleted mid-ingestion** | Ingestion completes, next reconciliation cleans up orphan |
| **Rapid sequential updates** | Each triggers webhook; delete+re-ingest is idempotent, last one wins |
| **Very large document timeout** | Existing Docling timeout handling (5 min), log failure for manual review |
| **Reconciliation overlaps** | Use n8n's built-in "only one execution at a time" setting |

## Idempotency Guarantees

The system is designed to be **safe to re-run**:

```
DELETE chunks WHERE document_id = X  → No-op if none exist
INSERT chunks with same point_id     → Qdrant upserts (overwrites)
Reconciliation runs twice            → Same result
```

## Race Condition Prevention

| Race Condition | Mitigation |
|----------------|------------|
| Update webhook + reconciliation both processing same doc | Both delete-then-insert; last writer wins, result is correct |
| Two updates to same doc in quick succession | Second webhook overwrites first; final state matches Paperless |
| Reconciliation deletes doc while webhook is ingesting | Ingestion completes and re-adds; consistent state |

The key insight: **delete + re-ingest is always safe** because Paperless is the source of truth.

---

# Testing Plan

## Unit Tests (n8n Code Nodes)

| Test | Validates |
|------|-----------|
| `parseWebhookPayload()` | Extracts document_id from both "added" and "updated" webhook formats |
| `buildQdrantDeleteFilter()` | Correctly constructs filter for `document_id` match |
| `compareDocumentSets()` | Finds orphans and missing docs given two ID lists |
| `parseReconciliationTimestamp()` | Handles null, valid, and malformed timestamps |

## Integration Tests

| Test | Steps | Expected |
|------|-------|----------|
| **Delete chunks by doc_id** | Insert 5 chunks for doc_123, call delete, query Qdrant | 0 chunks remain for doc_123 |
| **Delete non-existent doc** | Call delete for doc_999 (doesn't exist) | No error, 0 deleted |
| **Paperless API modified filter** | Query with `modified__gt=timestamp` | Only recent docs returned |
| **High-water mark persistence** | Write timestamp, read it back | Values match |

## E2E Test Scenarios

### Test 1: Document Add (existing - verify still works)

```bash
test_document_add() {
    drop_pdf "test.pdf" into intake/testfamily/
    wait_for_ingestion 60
    assert_chunks_exist "test.pdf" in Qdrant
}
```

### Test 2: Document Update via Webhook

```bash
test_document_update_webhook() {
    # Setup: ingest a document
    add_document "original.pdf" → doc_id=123
    wait_for_ingestion
    original_chunks=$(get_chunk_count 123)

    # Action: update document in Paperless (replace PDF)
    update_document 123 with "revised.pdf"
    wait_for_webhook 30

    # Assert: old chunks gone, new chunks present
    new_chunks=$(get_chunk_count 123)
    assert_chunks_different original_chunks new_chunks
    assert_content_contains 123 "revised content"
}
```

### Test 3: Document Delete via Reconciliation

```bash
test_document_delete_reconciliation() {
    # Setup: ingest a document
    add_document "todelete.pdf" → doc_id=456
    wait_for_ingestion
    assert_chunks_exist 456

    # Action: delete from Paperless
    delete_document 456 from Paperless

    # Assert: chunks still exist (no webhook for delete)
    assert_chunks_exist 456

    # Action: run reconciliation
    trigger_reconciliation
    wait_for_completion 60

    # Assert: chunks now gone
    assert_chunks_not_exist 456
}
```

### Test 4: Idempotent Re-ingestion

```bash
test_idempotent_reingestion() {
    add_document "same.pdf" → doc_id=789
    wait_for_ingestion
    chunk_ids_1=$(get_chunk_ids 789)

    # Trigger ingestion again (simulate duplicate webhook)
    trigger_ingestion 789
    wait_for_ingestion
    chunk_ids_2=$(get_chunk_ids 789)

    # Assert: same chunks, no duplicates
    assert_equal chunk_ids_1 chunk_ids_2
    assert_no_duplicate_chunks 789
}
```

### Test 5: Reconciliation Catches Missed Add

```bash
test_reconciliation_catches_missed_add() {
    # Disable webhook temporarily
    disable_webhook "document-added"

    # Add document (webhook won't fire)
    add_document "missed.pdf" → doc_id=101
    wait 10
    assert_chunks_not_exist 101  # Not ingested

    # Run reconciliation
    trigger_reconciliation
    wait_for_completion 120

    # Assert: document now ingested
    assert_chunks_exist 101

    # Cleanup
    enable_webhook "document-added"
}
```

### Test 6: Weekly Full Scan

```bash
test_weekly_full_scan() {
    # Corrupt high-water mark (set to future date)
    set_sync_timestamp "2099-01-01"

    # Add document (won't be caught by incremental)
    add_document "fullscan.pdf" → doc_id=202

    # Run incremental - should skip (doc older than watermark)
    trigger_reconciliation "incremental"
    assert_chunks_not_exist 202

    # Run full scan - should catch it
    trigger_reconciliation "full"
    wait_for_completion 120
    assert_chunks_exist 202
}
```

## Edge Case Tests

| Test | Scenario | Expected |
|------|----------|----------|
| **Rapid updates** | Update same doc 3x in 5 seconds | Final state matches last update |
| **Large document** | 50-page PDF update | Completes within timeout, all pages chunked |
| **Delete during ingest** | Delete doc while Docling is processing | Ingestion completes, next reconciliation cleans up |
| **Empty Qdrant** | Run reconciliation with 0 vectors | No errors, ingests all Paperless docs |
| **Empty Paperless** | Run reconciliation with 0 Paperless docs | Deletes all Qdrant vectors (if any) |

## Test Metrics

After all tests pass, verify:
- [ ] Qdrant document count == Paperless document count
- [ ] All family_ids in Qdrant exist as tags in Paperless
- [ ] No orphan chunks (document_id not in Paperless)
- [ ] Reconciliation log shows 0 errors

---

# Implementation Checklist

## Phase 1: Database Setup
- [ ] Create `sync` schema in chatui database
- [ ] Create `reconciliation_state` table
- [ ] Create `reconciliation_log` table
- [ ] Add migration file

## Phase 2: Modify Ingestion Workflow
- [ ] Add "Delete Existing Chunks" node after webhook trigger
- [ ] Implement Qdrant delete by document_id filter
- [ ] Test idempotent re-ingestion
- [ ] Export updated workflow JSON

## Phase 3: Paperless "Document Updated" Workflow
- [ ] Create workflow in Paperless admin
- [ ] Configure trigger: Document Updated
- [ ] Configure action: Webhook POST to n8n
- [ ] Test webhook fires on document edit

## Phase 4: Reconciliation Workflow
- [ ] Create new n8n workflow with scheduled trigger
- [ ] Implement high-water mark read/write
- [ ] Implement Paperless document listing with modified filter
- [ ] Implement Qdrant document_id extraction
- [ ] Implement orphan detection and deletion
- [ ] Implement missing document detection and ingestion trigger
- [ ] Add logging to reconciliation_log table
- [ ] Configure "only one execution at a time"

## Phase 5: Weekly Full Scan
- [ ] Create separate trigger or parameterized workflow
- [ ] Skip timestamp filter for full scan mode
- [ ] Schedule for Sunday 2 AM

## Phase 6: Configuration
- [ ] Add env vars to .env.example
- [ ] Update docker-compose.yml
- [ ] Document configuration options in CLAUDE.md

## Phase 7: Testing
- [ ] Run all E2E test scenarios
- [ ] Verify edge cases
- [ ] Confirm test metrics pass

## Phase 8: Documentation
- [ ] Update CLAUDE.md with sync architecture
- [ ] Update NEXT_STEPS.md (mark complete)
- [ ] Add troubleshooting guide for sync issues
