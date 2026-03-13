# TLS Termination + Ethical Walls (Per-Family Access Control) Design

**Date:** 2026-03-13
**Status:** Approved

---

## Feature 1: TLS Termination

### Goal

Encrypt all browser-to-server traffic via HTTPS. Required before any network exposure or client deployment.

### Architecture

A Caddy reverse proxy container (`matterproxy`) joins the `matternet` Docker network and becomes the single TLS termination point. Each service gets its own port — no path-prefix routing.

```
Browser ──HTTPS──▶ Caddy (:443)  ──HTTP──▶ matterchat:3000   (Chat UI)
Browser ──HTTPS──▶ Caddy (:3006) ──HTTP──▶ matterdash:3000   (Dashboard)
Browser ──HTTPS──▶ Caddy (:8000) ──HTTP──▶ mattervault:8000  (Paperless)
```

Internal services (n8n, Qdrant, databases, Redis) are NOT exposed to the host in production.

### Certificate Strategy

- **Default:** Caddy auto-generates a self-signed cert for the machine's hostname/IP. Works immediately. Browser shows a one-time "not secure" warning.
- **Upgrade (documented):** Generate a local CA root cert, install on client machines, configure Caddy to use it. No browser warnings. One-time setup per deployment.

### Port Mapping

| Port | Service | TLS |
|------|---------|-----|
| 443 | Chat UI | Yes |
| 3006 | Health Dashboard | Yes |
| 8000 | Paperless | Yes |
| 5678 | n8n | Internal only (not exposed) |
| 6333 | Qdrant | Internal only (not exposed) |

### Dev vs Production

- `ENABLE_TLS` env var (default `false`)
- When `false`: services expose ports directly like today, no Caddy, no changes to dev workflow
- When `true`: Caddy starts, services only accessible through proxy, `NODE_ENV=production` enables secure cookies
- Implementation: separate `docker-compose.tls.yml` overlay file, activated via `docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d`

### Chat-UI Changes

- Add `app.set('trust proxy', 1)` so Express reads real client IP from `X-Forwarded-For`
- Cookies already set `secure: process.env.NODE_ENV === 'production'` — just need `NODE_ENV=production` in TLS mode

### Caddy Configuration (Caddyfile)

```
{
  auto_https disable_redirects
}

:443 {
  tls internal
  reverse_proxy matterchat:3000
}

:3006 {
  tls internal
  reverse_proxy matterdash:3000
}

:8000 {
  tls internal
  reverse_proxy mattervault:8000
}
```

`tls internal` = auto-generated self-signed cert. Replace with explicit cert paths for local CA upgrade.

### Subdomain Upgrade Path (Future)

For clients with local DNS infrastructure, subdomains provide a cleaner UX:

- `mattervault.local` → Chat UI
- `paperless.mattervault.local` → Paperless
- `dashboard.mattervault.local` → Dashboard

Requires either:
- Local DNS server configured to resolve `*.mattervault.local` to the server IP
- `/etc/hosts` entries on each client machine (can be scripted)

This is a documented upgrade option, not the default. Could be offered as part of a premium onboarding package.

### `/etc/hosts` Script (for subdomain upgrade)

A setup script that adds entries to client machines:

```bash
# Example: scripts/setup-client-dns.sh
SERVER_IP="${1:?Usage: setup-client-dns.sh <server-ip>}"
echo "$SERVER_IP mattervault.local paperless.mattervault.local dashboard.mattervault.local" | sudo tee -a /etc/hosts
```

Document for Windows (PowerShell equivalent) and macOS.

---

## Feature 2: Ethical Walls (Per-Family Access Control)

### Goal

Restrict which families/matters each user can access. Prevents unauthorized access to client documents — a legal ethics requirement for multi-attorney firms.

### Why Not Paperless Permissions?

Paperless-ngx has object-level permissions (owner + view/edit per user/group) but **tag permissions do not cascade to documents**. Setting permissions on a tag only controls visibility of the tag itself, not documents with that tag. This is a [known limitation](https://github.com/paperless-ngx/paperless-ngx/discussions/3241). Therefore, family access control lives in Chat-UI.

### Database Schema

New migration (`007_family_access.sql` or next available number):

```sql
CREATE TABLE user_family_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, family_id)
);

CREATE INDEX idx_user_family_access_user ON user_family_access(user_id);
CREATE INDEX idx_user_family_access_family ON user_family_access(family_id);
```

### Access Rules

- **Admins:** See all families automatically. No entries needed in `user_family_access`.
- **Regular users:** Only see families explicitly assigned to them via `user_family_access`.
- **No assignments:** User sees empty family dropdown with message "No matters assigned. Contact your administrator."

### Enforcement Points (3 places)

1. **Family dropdown** (`auth.js: fetchUserFamilies`)
   - Currently returns all families from Qdrant for any authenticated user
   - Change: For non-admin users, filter results against `user_family_access` table
   - Admins bypass the check

2. **Chat/streaming endpoints** (`api.js`, `streaming.js`)
   - Before forwarding a question to n8n, verify the user has access to the requested `family_id`
   - Reject with 403 `FAMILY_ACCESS_DENIED` if not authorized
   - Admins bypass the check

3. **Conversation creation** (`routes/conversations.js: POST /`)
   - Same family access check when creating a conversation with a `family_id`
   - Reject with 403 if not authorized

### What Doesn't Change

- **Qdrant queries** — already filtered by `family_id` at query time
- **Audit logging** — already captures `family_id` and `user_id`
- **Document preview** — uses Paperless token (Paperless enforces its own permissions)
- **Existing conversations** — users keep access to conversations they already created (ownership check is `user_id`, not `family_id`)

### Admin UI

New section on the admin page (or `/admin/access` page):

- **User list** with family assignment toggles
- **Family × User grid** — checkboxes to grant/revoke access
- **Bulk operations** — "Grant all families" / "Revoke all" per user
- Only visible to admin users

### API Endpoints

```
GET    /api/admin/family-access          — List all assignments
GET    /api/admin/family-access/:userId  — List user's families
POST   /api/admin/family-access          — Grant access { user_id, family_id }
DELETE /api/admin/family-access/:id      — Revoke access
```

All admin-only (`requireAuth` + `requireAdmin`).

### Helper Function

```js
async function userCanAccessFamily(userId, role, familyId) {
  if (role === 'admin') return true;
  const { rows } = await db.query(
    'SELECT 1 FROM user_family_access WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );
  return rows.length > 0;
}
```

Used at all 3 enforcement points.

---

## Implementation Order

1. **TLS first** — infrastructure, no application logic changes beyond `trust proxy`
2. **Ethical walls second** — application logic, builds on existing auth

Both are independent and can be worked on in parallel if needed.

---

## Test Coverage

### TLS
- Caddy config syntax validation
- `trust proxy` header forwarding test
- Secure cookie flag test (when `NODE_ENV=production`)

### Ethical Walls
- `userCanAccessFamily` unit tests (admin bypass, granted access, denied access)
- Family dropdown filtering (admin sees all, user sees assigned only, user with no assignments sees empty)
- Chat endpoint rejects unauthorized family (403)
- Conversation creation rejects unauthorized family (403)
- Admin API CRUD tests for family-access management
- Migration creates table and indexes
