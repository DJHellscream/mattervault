# MatterVault - Potential Next Steps

*Generated 2026-01-29*

## Recently Completed
- V5 Chat workflow with conversation persistence + audit logging
- Paperless-ngx authentication integration
- Health dashboard with metrics, sparklines, uptime badges, recent queries
- SQL sanitization/escaping
- E2E test infrastructure
- CLAUDE.md documentation update
- Admin UI for audit logs (with role sync from Paperless)
- Mobile Chat UI (responsive layout, touch gestures, icon-only header on small screens)
- Document change/delete sync (Qdrant ↔ Paperless reconciliation)

---

## Potential Next Steps

### Features

**Email Alerting**
- Send alerts via email when services go down
- Dashboard already tracks alerts, just needs email transport
- Could use SMTP or a service like SendGrid

**Per-Family Access Control**
- Currently open access (any user can query any family)
- Could restrict users to specific families based on Paperless tag permissions
- More relevant as user base grows

### Operations

**Production Hardening**
- HTTPS/TLS termination (nginx or traefik)
- Proper secrets management (not .env files)
- Rate limiting on chat API

---

## Decision Factors

| Task | Effort | Impact | Dependencies |
|------|--------|--------|--------------|
| Email alerting | Low | High | SMTP config |
| Per-family access | High | Medium | Paperless permissions setup |
| Production hardening | Medium | High | Domain, certs |

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
