# MatterVault - Potential Next Steps

*Updated 2026-03-13 (evening)*

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
- **Prompt Library (Quick Actions)**: welcome screen cards + input area lightning bolt menu, 5 default prompts, admin management page with drag-to-reorder and icon picker, database-backed CRUD API
- **bge-m3 NaN embedding fix**: Embed Question node retries with text modifications when Ollama produces NaN (token pattern bug workaround)
- **Chat markdown rendering**: formatMessage renders headings, lists, horizontal rules, bold/italic properly
- **SSE error propagation**: stream errors now show "Streaming failed: ..." instead of empty bubbles
- **Chat UI polish**: dropdown option dark theme styling, audit page scroll fix, audit table vertical alignment
- **Cross-encoder reranking**: Qwen3-Reranker-8B scores search results 0-10, reranks top 25 → top 5 before LLM generation
- **Codex review fixes**: proper db client for prompt reorder transaction, cursor-based audit export streaming, paginated Qdrant scroll for family discovery
- **Route integration tests**: 73 supertest-based tests covering auth middleware, all CRUD routes, admin gates, transaction correctness
- **TLS termination**: Caddy reverse proxy via docker-compose.tls.yml overlay, self-signed certs, trust-proxy for client IPs
- **Ethical walls (per-family access control)**: user_family_access table, userCanAccessFamily helper, enforcement on family dropdown + chat + conversation endpoints, admin CRUD API

---

## Potential Next Steps

### Features

**Metadata Filtering** *(Priority: Medium)*
- Problem: Can only filter by `family_id`, but lawyers want to filter by date range, document type, correspondent
- Solution: Propagate Paperless metadata to Qdrant payloads, expose in Chat UI
- Fields to add: `document_date`, `correspondent`, `document_type`, `tags`
- Effort: 3-4 hours (n8n ingestion + chat workflow + Chat UI changes)


### AI Quality Upgrades

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

### Operations

**Secrets Management** *(Priority: Low)*
- Move from .env files to proper secrets management
- Rate limiting on chat API
- Effort: 2-3 hours

---

## Decision Factors

| Task | Effort | Impact | Priority |
|------|--------|--------|----------|
| Metadata filtering | Medium | Medium | Nice to have |
| Contextual chunking | Medium | Medium | After real-world testing |
| Visual Intelligence | High | Medium | Future |
| Citation export | Medium | Medium | Future |
| Secrets management | Low | Low | When needed |

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
