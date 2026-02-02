# MatterVault - Potential Next Steps

*Updated 2026-02-02*

## Recently Completed
- V5 Chat workflow with conversation persistence + audit logging
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
| Metadata filtering | Medium | Medium | Nice to have |
| Per-family access | High | Medium | When needed |
| Production hardening | Medium | High | Before go-live |

---

## Deferred to Production

**Backup Scripts** *(deferred 2026-01-29)*
- Qdrant vectors + PostgreSQL dumps
- Deferred because Mac Studio deployment will use machine-level imaging (Time Machine/APFS snapshots)
- Revisit if off-site backups or selective restore needed

---

## Not Planned

**Query Caching** *(decided 2026-01-29)*
- Redis cache for repeated queries to skip LLM
- Not implementing: documents can change in Paperless at any time, cached answers could be stale/wrong
- Freshness and accuracy more important than speed for legal document queries

---

*Pick what matters most for your workflow and let me know when ready.*
