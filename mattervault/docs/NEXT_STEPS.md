# MatterVault - Potential Next Steps

*Updated 2026-03-11*

## Recently Completed
- Chat workflow with conversation persistence + audit logging
- Paperless-ngx authentication integration
- Health dashboard with metrics, sparklines, uptime badges, recent queries
- SQL sanitization/escaping
- E2E test infrastructure (full, sync, audit modes)
- CLAUDE.md documentation update
- Admin UI for audit logs (with role sync from Paperless)
- Mobile Chat UI (responsive layout, touch gestures, icon-only header on small screens)
- Document change/delete sync (Qdrant ↔ Paperless reconciliation)
- Audit system E2E tests (schema, partitions, API endpoints)
- Initialization script (scripts/init-mattervault.sh)
- Dashboard consolidated into main docker-compose
- Email alerting via n8n webhook (dashboard → n8n → SMTP)
- Page-level citation linking in Chat UI (click citation → PDF viewer opens to page)
- Dashboard clear alerts button
- LLM upgrade: llama3.1:8b → qwen3:8b (better reasoning, instruction following, same VRAM)
- Created .env.example for new deployments
- Comprehensive tech stack evaluation (2026-02-24) — validated architecture choices
- Qdrant `is_tenant: true` index for family_id (optimized per-family disk I/O)
- Pre-consume validation script (rejects docs from unrecognized intake folders)
- Family_id mismatch detection + auto-correction in reconciliation workflow
- Dashboard "Reconcile Now" button (manual trigger for reconciliation)

---

## Potential Next Steps

### Reliability & Operations

**Ingestion Status Visibility** *(Priority: High)*
- Problem: Paralegals drop files into `/intake/<family>/` but have no visibility into processing status
- Solution: Use Paperless tags to show pipeline status
- Tag flow: `intake` → `processing` → `ai_ready` (or `error`)
- Implementation:
  1. n8n adds `processing` tag when ingestion starts
  2. On success: add `ai_ready`, remove `processing`
  3. On failure: add `error`, remove `processing`
- Paralegals filter by tag in Paperless to see stuck documents
- Effort: 2-3 hours (n8n workflow changes only)

**Large PDF Chunking** *(Priority: High)*
- Problem: Docling times out on PDFs >50 pages (discovery docs are often 200+ pages)
- Solution: Pre-ingest chunking in n8n before sending to Docling
- Implementation:
  1. Check page count before Docling call
  2. If >25 pages: split into 25-page chunks using PyPDF2
  3. Process each chunk through Docling separately
  4. Track `page_offset` so page numbers stay accurate in Qdrant
  5. Recombine chunks before embedding
- Effort: 4-6 hours (Python script + n8n workflow changes)

**Hallucination Testing** *(Priority: High)*
- Problem: Unknown how system responds when answer doesn't exist in documents
- Test: Send adversarial queries (e.g., "What is the liability cap?" when none exists)
- Expected: System should say "I don't find that information" not fabricate an answer
- May require system prompt tuning in n8n chat workflow
- Effort: 1-2 hours (testing + prompt adjustments)

### Features

**Prompt Library (Quick Actions)** *(Priority: Medium)*
- Problem: Junior associates ask inconsistent questions, get inconsistent results
- Solution: Dropdown in Chat UI with pre-built "Quick Actions" that standardize queries
- Example actions:
  - "Summarize Key Terms" → Structured summary of document provisions
  - "Find Risk Clauses" → Identify indemnification, liability, termination clauses
  - "Draft Statutory Summary" → Extract statutory references with citations
  - "Compare to Template" → Highlight deviations from standard language
- Implementation: Chat UI dropdown + prompt templates stored in config
- Benefit: Consistent output quality, training aid for new staff
- Effort: 3-4 hours (Chat UI + prompt engineering)

**Metadata Filtering** *(Priority: Medium)*
- Problem: Can only filter by `family_id`, but lawyers want to filter by date range, document type, correspondent
- Solution: Propagate Paperless metadata to Qdrant payloads, expose in Chat UI
- Fields to add: `document_date`, `correspondent`, `document_type`, `tags`
- Effort: 3-4 hours (n8n ingestion + chat workflow + Chat UI changes)

**Per-Family Access Control** *(Priority: Low)*
- Currently open access (any user can query any family)
- Could restrict users to specific families based on Paperless tag permissions
- More relevant as user base grows
- Effort: High

### Future Vision

**Visual Intelligence** *(Priority: Future)*
- Problem: Charts, graphs, and tables in PDFs are not searchable as text
- Solution: Integrate Llama 3.2 Vision to analyze visual elements detected by Docling
- Implementation:
  1. Docling detects images/charts/tables in PDF
  2. Pass visual elements to Llama 3.2 Vision
  3. Generate descriptive text (e.g., "Bar chart showing revenue growth from $1M to $5M, 2020-2024")
  4. Index descriptions in Qdrant alongside document text
- Benefit: "What was the revenue trend?" becomes answerable even from charts
- Effort: High (new model integration, pipeline changes)
- Dependencies: Llama 3.2 Vision availability in Ollama

**Citation Export** *(Priority: Future)*
- Format citations for court filings (Bluebook, local court rules)
- Export answers with properly formatted legal citations

**Saved Query Templates** *(Priority: Future)*
- Firm-wide library of reusable queries
- Share effective prompts across the organization

### AI Quality Upgrades (from 2026-02-24 evaluation)

**Upgrade Embeddings to BGE-M3** *(Priority: High)*
- Problem: nomic-embed-text (768d) is outperformed by BGE-M3 (1024d) on MTEB benchmarks
- BGE-M3 also provides native sparse+dense vectors from one model (can replace hashCode BM25 tokenizer)
- 8192 token context vs nomic's 2048 — handles longer chunks without truncation
- Implementation:
  1. `ollama pull bge-m3`
  2. Create new Qdrant collection `mattervault_documents` with 1024 dimensions
  3. Update n8n ingestion workflow to use `bge-m3`
  4. Re-ingest all documents (maintenance window)
  5. Switch chat workflow to query new collection
- Effort: 4-6 hours (requires full re-index)
- Risk: Medium (breaking change, needs validation)

**Add Cross-Encoder Reranking** *(Priority: Medium)*
- Problem: Current LLM-based reranking (qwen3:8b scoring 0-10) is slow and less accurate than dedicated rerankers
- Solution: Use bge-reranker-v2-m3 (~600M params) — designed specifically for reranking
- Improves RAG accuracy 20-35% over no reranking, with 200-500ms latency per batch
- Pairs naturally with BGE-M3 embeddings (same model family)
- Effort: 3-4 hours (new model + n8n pipeline change)

**Contextual Chunking** *(Priority: Low)*
- Problem: Chunks like "The above provisions apply..." lose meaning without parent section
- Solution: During ingestion, prepend LLM-generated context summary to each chunk before embedding
- Research shows 10-12% retrieval improvement for reference-heavy docs (common in legal)
- Cost: One additional LLM call per chunk during ingestion
- Effort: 3-4 hours

### Code Quality (from 2026-02-24 evaluation)

**Add Process Error Handlers** *(Priority: High)*
- Chat-UI missing `process.on('unhandledRejection')` and `process.on('uncaughtException')`
- Could cause silent crashes in production
- Effort: 30 minutes

**Call cleanupExpiredSessions()** *(Priority: Medium)*
- Function exported in auth.js but never called — sessions accumulate indefinitely
- Add a setInterval or node-cron schedule to clean up expired sessions
- Effort: 30 minutes

**Make Dashboard Families Dynamic** *(Priority: Medium)*
- Dashboard metricsCollector.js hardcodes `['morrison', 'johnson']` for family distribution
- Should query Qdrant for actual family_id values dynamically
- Effort: 1 hour

**Docker Health Checks + Resource Limits** *(Priority: Medium)*
- No Docker healthcheck directives — Docker can't detect or auto-restart failed services
- No CPU/memory limits — one runaway OCR job could crash the entire stack
- Effort: 2 hours

### Operations

**Production Hardening** *(Priority: Medium)*
- HTTPS/TLS termination (nginx or traefik)
- Proper secrets management (not .env files)
- Rate limiting on chat API
- Effort: Medium

---

## Decision Factors

| Task | Effort | Impact | Priority |
|------|--------|--------|----------|
| Ingestion status tags | Low | High | Do first |
| Large PDF chunking | Medium | High | Do second |
| Hallucination testing | Low | High | Do third |
| Upgrade embeddings (BGE-M3) | Medium | High | After reliability |
| Cross-encoder reranking | Medium | High | After embeddings |
| Prompt Library | Medium | High | After core reliability |
| Process error handlers | Low | Medium | Quick win |
| Session cleanup | Low | Low | Quick win |
| Dynamic dashboard families | Low | Low | Quick win |
| Docker health checks | Low | Medium | Before go-live |
| Metadata filtering | Medium | Medium | Nice to have |
| Per-family access | High | Medium | When needed |
| Contextual chunking | Medium | Medium | After BGE-M3 |
| Production hardening | Medium | High | Before go-live |
| Visual Intelligence | High | Medium | Future |
| Citation export | Medium | Medium | Future |

---

## Deferred to Production

**Backup Scripts** *(deferred 2026-01-29)*
- Qdrant vectors + PostgreSQL dumps
- Deferred because Mac Studio deployment will use machine-level imaging (Time Machine/APFS snapshots)
- Revisit if off-site backups or selective restore needed

---

## Not Planned

**Cross-Family Analysis** *(decided 2026-02-04)*
- Query across multiple families/matters simultaneously
- Not implementing: violates law firm ethical requirements
- Reasons:
  - Ethical walls: attorneys are often "walled off" from certain matters due to conflicts
  - Client confidentiality: mixing results could inadvertently waive privilege
  - Malpractice risk: accidental exposure to conflicting client information
- Family isolation is a **feature**, not a limitation—it enforces required ethical boundaries

**Query Caching** *(decided 2026-01-29)*
- Redis cache for repeated queries to skip LLM
- Not implementing: documents can change in Paperless at any time, cached answers could be stale/wrong
- Freshness and accuracy more important than speed for legal document queries

**Convex / Supabase Migration** *(decided 2026-03-11)*
- Evaluated replacing Qdrant + 3x PostgreSQL with Convex or Supabase
- Not implementing: current stack is validated and optimal for air-gapped deployment
- Convex requires cloud connectivity (violates air-gap requirement)
- Supabase adds complexity without meaningful benefit over purpose-built components
- pgvector cannot replace Qdrant (no native sparse vectors, no tenant optimization)

---

*Pick what matters most for your workflow and let me know when ready.*
