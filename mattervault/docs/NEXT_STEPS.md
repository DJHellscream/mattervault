# MatterVault - Potential Next Steps

*Updated 2026-03-12*

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
- Ingestion status tags: `intake` → `processing` → `ai_ready` / `ingestion_error`
- Large PDF support: 10-min Docling timeout + `scripts/split-pdf.py` for 200+ page docs
- Hallucination testing: adversarial test suite + system prompt hardening
- Embeddings upgrade: nomic-embed-text (768d) → BGE-M3 (1024d), Qdrant collection v3
- Process error handlers (`unhandledRejection` + `uncaughtException` in Chat-UI)
- Docker health checks + resource limits on all services
- Session cleanup: `cleanupExpiredSessions()` runs on startup + every 24 hours
- Deployment hardening: `.env` untracked, `.gitignore`, `.env.example` template
- Audio ingestion via Docling Whisper ASR (WAV, MP3, M4A)
- Dynamic family dropdown (queries Qdrant for families with actual vectors)
- Citation fuzzy matching (handles filename normalization, clean titles in context)
- Reconciliation sequential fetch fix (prevents race condition with parallel HTTP calls)
- System prompt tuned for exhaustive responses (lists all items, not just highlights)
- Docling poll interval reduced from 5s to 2s

---

## Potential Next Steps

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

### AI Quality Upgrades

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

### Future Vision

**Visual Intelligence** *(Priority: Future)*
- Problem: Charts, graphs, and tables in PDFs are not searchable as text
- Solution: Integrate Llama 3.2 Vision to analyze visual elements detected by Docling
- Benefit: "What was the revenue trend?" becomes answerable even from charts
- Effort: High (new model integration, pipeline changes)

**Citation Export** *(Priority: Future)*
- Format citations for court filings (Bluebook, local court rules)
- Export answers with properly formatted legal citations

**Saved Query Templates** *(Priority: Future)*
- Firm-wide library of reusable queries
- Share effective prompts across the organization

### Operations

**Production Hardening** *(Priority: Medium — required before network exposure)*
- HTTPS/TLS termination (nginx or traefik)
- Proper secrets management (not .env files)
- Rate limiting on chat API
- Effort: 4-6 hours

---

## Decision Factors

| Task | Effort | Impact | Priority |
|------|--------|--------|----------|
| Prompt Library | Medium | High | Best next feature |
| Cross-encoder reranking | Medium | High | Best quality improvement |
| Metadata filtering | Medium | Medium | Nice to have |
| Production hardening | Medium | High | Before network go-live |
| Contextual chunking | Medium | Medium | After real-world testing |
| Per-family access | High | Medium | When needed |
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
