# MatterVault - Potential Next Steps

*Generated 2026-01-29*

## Recently Completed
- V5 Chat workflow with conversation persistence + audit logging
- Paperless-ngx authentication integration
- Health dashboard with metrics, sparklines, uptime badges, recent queries
- SQL sanitization/escaping
- E2E test infrastructure
- CLAUDE.md documentation update

---

## Potential Next Steps

### Features

**Admin UI for Audit Logs**
- Simple page in chat-ui to view/search/export audit logs
- API already exists (`/api/audit/export`, `/api/audit/summary`)
- Would allow admins to review queries without using curl

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

### Performance

**Caching Layer**
- Redis cache for frequent/repeated queries
- Could skip LLM for identical questions within time window
- Trade-off: freshness vs speed

### Polish

**Mobile Chat UI**
- Improve responsive design for chat-ui
- Better touch interactions
- Conversation list on mobile

---

## Decision Factors

| Task | Effort | Impact | Dependencies |
|------|--------|--------|--------------|
| Admin UI for audit | Medium | Medium | None |
| Email alerting | Low | High | SMTP config |
| Per-family access | High | Medium | Paperless permissions setup |
| Production hardening | Medium | High | Domain, certs |
| Caching layer | Medium | Medium | Query patterns analysis |
| Mobile chat UI | Medium | Low | Design decisions |

---

## Deferred to Production

**Backup Scripts** *(deferred 2026-01-29)*
- Qdrant vectors + PostgreSQL dumps
- Deferred because Mac Studio deployment will use machine-level imaging (Time Machine/APFS snapshots)
- Revisit if off-site backups or selective restore needed

---

*Pick what matters most for your workflow and let me know when ready.*
