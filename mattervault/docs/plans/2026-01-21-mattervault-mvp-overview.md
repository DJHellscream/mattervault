# Mattervault MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a working document intelligence pipeline that ingests PDFs, preserves structure, enables semantic search, and provides chat-based Q&A with family-level data isolation.

**Architecture:** Paperless-ngx captures and OCRs documents. n8n orchestrates the pipeline: receiving webhooks, calling Docling for parsing, chunking text, embedding via Ollama, and storing in Qdrant. A second n8n workflow handles chat queries with hybrid search and re-ranking.

**Tech Stack:** Paperless-ngx, n8n, Qdrant (hybrid search), Ollama (nomic-embed-text, Qwen3-Reranker, llama3.1:8b), Docling, PostgreSQL, Redis

---

## Phase Overview

| Phase | Description | Status |
|-------|-------------|--------|
| **Phase 1** | Document Ingestion Pipeline | **COMPLETE** |
| **Phase 2** | Chat Query Pipeline (Production-Grade) | **COMPLETE** |
| **Phase 3** | Family Selector UI | **COMPLETE** |

```
Phase 1: Document Ingestion Pipeline [COMPLETE]
   PDF drop → Paperless → n8n webhook → Docling → Chunk → Embed → Qdrant

Phase 2: Chat Query Pipeline [COMPLETE]
   User query → Embed (dense) → Hybrid Search (dense + BM25) → RRF Fusion
              → Cross-Encoder Rerank (Qwen3) → Top 5 → LLM → Response

Phase 3: Family Selector UI [COMPLETE]
   Session start → Pick family → All queries filtered by family_id
```

---

## Phase 1: Document Ingestion Pipeline

**Status:** COMPLETE (2026-01-26)

**Detailed Plan:** `2026-01-21-mvp-01-document-ingestion.md`

**Components:**
1. Paperless webhook configuration (document.added trigger)
2. n8n workflow: Webhook receiver
3. n8n workflow: Docling HTTP call (PDF → Markdown)
4. n8n workflow: Parent-Child chunking logic
5. n8n workflow: Ollama embedding call
6. n8n workflow: Qdrant upsert with family_id

**Verification Milestone:** ACHIEVED
- Drop test PDF in `./intake/morrison/` - Working
- Confirm vectors appear in Qdrant with correct `family_id: "morrison"` - Verified (30 chunks stored)
- Query Qdrant directly to verify payload structure - Confirmed parent-child structure intact

**Implementation Notes:**
- Docling uses async conversion (`/v1/convert/file/async`) with polling loop
- Point IDs are integers: `document_id * 10000 + chunk_index`
- Document info passed through polling loop (Wait node loses references)
- Family tag validation added - documents without family tag produce error

**Future Testing Needed:**
- Chunking quality across different document types
- Error handling and retry mechanisms throughout pipeline
- Edge cases: large PDFs (>50 pages), scanned documents, complex tables

**Dependencies:**
- Docker services running (`docker compose up -d`)
- Native services running (`.\scripts\start-native.ps1`)
- Qdrant collection initialized (`./scripts/init-qdrant.sh`)

---

## Phase 2: Chat Query Pipeline (Production-Grade)

**Status:** COMPLETE (2026-01-27)

**Detailed Plan:** `2026-01-21-mvp-02-chat-query.md`

**Architecture Decision:** Use HTTP Request nodes (not native Qdrant nodes) for full Query API access, enabling hybrid search and custom reranking.

**Components:**
1. n8n Chat Trigger for user questions
2. Dense embedding via Ollama (nomic-embed-text)
3. **Hybrid Search**: Dense + BM25 Sparse with RRF fusion
4. **Cross-Encoder Reranking**: Qwen3-Reranker (top 25 → top 5)
5. LLM prompt construction with legal citations
6. Response generation via Ollama (llama3.1:8b)

**Why Hybrid + Reranking (Legal-Grade Accuracy):**
| Component | Catches | Example |
|-----------|---------|---------|
| Dense search | Semantic meaning | "estate distribution" ↔ "inheritance" |
| BM25 sparse | Exact terms | "Section 2.1(a)", "Form 1040" |
| Cross-encoder | ML relevance scoring | Query-document pair analysis |

**Verification Milestone:**
- Query with legal citation → Exact match found via BM25
- Query with paraphrase → Semantic match found via dense
- Reranking improves relevance ordering
- Response includes accurate source citations

**Dependencies:**
- Phase 1 complete (documents indexed in Qdrant)
- New Qdrant collection with sparse vector support
- Qwen3-Reranker model installed on Ollama

---

## Phase 3: Family Selector UI

**Detailed Plan:** `2026-01-21-mvp-03-family-selector.md`

**Components:**
1. Session initialization workflow
2. Family selection prompt/dropdown
3. Session state storage (family_id persists across queries)
4. Query workflow integration (reads family_id from session)

**Verification Milestone:**
- Start new chat session
- Select "Johnson" family
- Query returns only Johnson documents (not Morrison)

**Dependencies:**
- Phase 2 complete (chat working)
- Multiple families with test documents

---

## Integration Test Plan

After all phases complete:

| Test | Input | Expected Output |
|------|-------|-----------------|
| Isolation | Query Morrison docs as Johnson | No results / "not found" |
| Citation | Ask about specific clause | Response includes doc name + page |
| Multi-page | Query spanning multiple chunks | Coherent answer from parent context |
| Re-index | Change family tag in Paperless | Old vectors deleted, new ones created |

---

## File Locations

| Artifact | Path |
|----------|------|
| Master Plan (this file) | `docs/plans/2026-01-21-mattervault-mvp-overview.md` |
| Phase 1 Plan | `docs/plans/2026-01-21-mvp-01-document-ingestion.md` |
| Phase 2 Plan | `docs/plans/2026-01-21-mvp-02-chat-query.md` |
| Phase 3 Plan | `docs/plans/2026-01-21-mvp-03-family-selector.md` |
| n8n Workflows | `n8n-workflows/*.json` |
| Test Documents | `intake/morrison/`, `intake/johnson/` |

---

## Execution Order

1. Read Phase 1 plan → Execute → Verify milestone
2. Read Phase 2 plan → Execute → Verify milestone
3. Read Phase 3 plan → Execute → Verify milestone
4. Run integration tests
5. Commit all workflows and update CLAUDE.md
