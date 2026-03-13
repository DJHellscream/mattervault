# TLS + Ethical Walls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HTTPS via Caddy reverse proxy and per-family access control (ethical walls) to MatterVault.

**Architecture:** TLS is a Caddy container in a docker-compose overlay that terminates HTTPS on ports 443/3006/8000 and proxies to internal services. Ethical walls are a `user_family_access` table with enforcement at 3 API points (family dropdown, chat endpoints, conversation creation). Admins bypass all family checks.

**Tech Stack:** Caddy 2 (reverse proxy), PostgreSQL migration (new table), Express.js (access checks), supertest (tests)

---

## Part 1: TLS Termination

### Task 1: Create Caddy config and TLS compose overlay

**Files:**
- Create: `caddy/Caddyfile`
- Create: `docker-compose.tls.yml`
- Modify: `.env.example` (add ENABLE_TLS docs)

**Step 1: Create caddy directory and Caddyfile**

Create `caddy/Caddyfile`:

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

**Step 2: Create the TLS compose overlay**

Create `docker-compose.tls.yml`:

```yaml
# TLS overlay — use with: docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
# Adds Caddy reverse proxy for HTTPS on ports 443, 3006, 8000
# Services stop exposing ports directly; all traffic goes through Caddy.
services:
  # Override: remove direct host port bindings
  paperless:
    ports: !override []

  chat-ui:
    ports: !override []
    environment:
      - NODE_ENV=production

  health-dashboard:
    ports: !override []

  n8n:
    ports: !override []

  qdrant:
    ports: !override []

  # New: Caddy reverse proxy for TLS termination
  proxy:
    image: caddy:2-alpine
    container_name: matterproxy
    restart: always
    ports:
      - "443:443"
      - "3006:3006"
      - "8000:8000"
      - "80:80"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - matternet
    depends_on:
      - chat-ui
      - health-dashboard
      - paperless

volumes:
  caddy_data:
  caddy_config:
```

**Step 3: Add TLS section to .env.example**

Add after the existing QUICK START section in `.env.example`:

```bash
# ==============================================================================
# TLS / HTTPS (Optional — for production deployments)
# ==============================================================================
#
# To enable HTTPS, use the TLS overlay:
#   docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
#
# This adds a Caddy reverse proxy that:
#   - Terminates TLS on ports 443 (Chat UI), 3006 (Dashboard), 8000 (Paperless)
#   - Auto-generates self-signed certificates (browser will warn on first visit)
#   - Removes direct HTTP port exposure for all services
#
# Access with TLS enabled:
#   Chat UI:    https://localhost
#   Paperless:  https://localhost:8000
#   Dashboard:  https://localhost:3006
#
# For a custom hostname (e.g., on LAN):
#   1. Edit caddy/Caddyfile — replace :443 with your hostname
#   2. Add hostname to client /etc/hosts (see scripts/setup-client-dns.sh)
#
```

**Step 4: Commit**

```
feat(tls): add Caddy reverse proxy config and docker-compose TLS overlay
```

---

### Task 2: Add trust-proxy to Chat-UI for correct client IPs behind Caddy

**Files:**
- Modify: `chat-ui/src/index.js:27` (after `const app = express()`)
- Test: `chat-ui/src/index.test.js` (existing, verify still passes)

**Step 1: Add trust proxy setting**

In `chat-ui/src/index.js`, after line 27 (`const app = express();`), add:

```js
// Trust first proxy (Caddy) for correct client IP in X-Forwarded-For
app.set('trust proxy', 1);
```

**Step 2: Verify existing tests pass**

Run: `cd /workspace/mattervault/chat-ui && npm test`
Expected: All 59 tests pass

**Step 3: Commit**

```
feat(tls): add trust-proxy for correct client IPs behind reverse proxy
```

---

### Task 3: Create client DNS setup script

**Files:**
- Create: `scripts/setup-client-dns.sh`

**Step 1: Create the script**

Create `scripts/setup-client-dns.sh`:

```bash
#!/usr/bin/env bash
# Setup client machine DNS for MatterVault subdomain access (optional upgrade)
#
# Usage:
#   Linux/Mac: sudo ./setup-client-dns.sh <server-ip>
#   Windows:   Run PowerShell as admin, then:
#              Add-Content C:\Windows\System32\drivers\etc\hosts "<server-ip> mattervault.local"
#
# This is optional — port-based access works without DNS setup.

set -euo pipefail

SERVER_IP="${1:?Usage: $0 <server-ip>}"
HOSTNAME="${2:-mattervault.local}"

# Validate IP format
if ! echo "$SERVER_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Invalid IP address '$SERVER_IP'"
  exit 1
fi

HOSTS_FILE="/etc/hosts"
ENTRY="$SERVER_IP $HOSTNAME"

# Check if already configured
if grep -qF "$HOSTNAME" "$HOSTS_FILE" 2>/dev/null; then
  echo "Warning: $HOSTNAME already exists in $HOSTS_FILE"
  grep "$HOSTNAME" "$HOSTS_FILE"
  echo ""
  echo "To update, remove the existing entry first, then re-run this script."
  exit 0
fi

echo "$ENTRY" >> "$HOSTS_FILE"
echo "Added to $HOSTS_FILE: $ENTRY"
echo ""
echo "You can now access MatterVault at:"
echo "  Chat UI:    https://$HOSTNAME"
echo "  Paperless:  https://$HOSTNAME:8000"
echo "  Dashboard:  https://$HOSTNAME:3006"
```

**Step 2: Make executable**

Run: `chmod +x scripts/setup-client-dns.sh`

**Step 3: Commit**

```
feat(tls): add client DNS setup script for optional subdomain access
```

---

## Part 2: Ethical Walls (Per-Family Access Control)

### Task 4: Database migration for user_family_access

**Files:**
- Create: `chat-ui/migrations/008_family_access.sql`

**Step 1: Create the migration**

Create `chat-ui/migrations/008_family_access.sql`:

```sql
-- Per-family access control (ethical walls)
-- Admins bypass this table and see all families.
-- Regular users only see families with a row in this table.

CREATE TABLE IF NOT EXISTS user_family_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, family_id)
);

CREATE INDEX IF NOT EXISTS idx_user_family_access_user ON user_family_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_family_access_family ON user_family_access(family_id);
```

**Step 2: Verify migration file is picked up**

Run: `ls /workspace/mattervault/chat-ui/migrations/*.sql | sort`
Expected: 008_family_access.sql appears last

**Step 3: Commit**

```
feat(ethical-walls): add user_family_access migration for per-family access control
```

---

### Task 5: Family access helper + integration into auth.js

**Files:**
- Modify: `chat-ui/src/auth.js` (add `userCanAccessFamily`, modify `fetchUserFamilies`)
- Test: Create `chat-ui/src/auth.test.js`

**Step 1: Write the tests**

Create `chat-ui/src/auth.test.js`:

```js
/**
 * Tests for family access control in auth.js
 */

jest.mock('./db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

// Mock Redis to prevent real connection
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  }));
});

const db = require('./db');
const { userCanAccessFamily } = require('./auth');

describe('userCanAccessFamily', () => {
  afterEach(() => jest.resetAllMocks());

  test('admin always has access', async () => {
    const result = await userCanAccessFamily('admin-id', 'admin', 'morrison');
    expect(result).toBe(true);
    // Should NOT query the database
    expect(db.query).not.toHaveBeenCalled();
  });

  test('user with access granted returns true', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });

    const result = await userCanAccessFamily('user-id', 'user', 'morrison');
    expect(result).toBe(true);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('user_family_access'),
      ['user-id', 'morrison']
    );
  });

  test('user without access returns false', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const result = await userCanAccessFamily('user-id', 'user', 'johnson');
    expect(result).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /workspace/mattervault/chat-ui && npx jest src/auth.test.js --verbose`
Expected: FAIL — `userCanAccessFamily` not exported

**Step 3: Add userCanAccessFamily to auth.js**

Add before the `module.exports` block at the bottom of `chat-ui/src/auth.js`:

```js
/**
 * Check if a user has access to a specific family
 * Admins always have access. Regular users need an entry in user_family_access.
 * @param {string} userId - User UUID
 * @param {string} role - User role ('admin' or 'user')
 * @param {string} familyId - Family ID to check
 * @returns {Promise<boolean>}
 */
async function userCanAccessFamily(userId, role, familyId) {
  if (role === 'admin') return true;
  const { rows } = await db.query(
    'SELECT 1 FROM user_family_access WHERE user_id = $1 AND family_id = $2',
    [userId, familyId]
  );
  return rows.length > 0;
}
```

And add `userCanAccessFamily` to the `module.exports` object.

**Step 4: Modify fetchUserFamilies to filter by access**

In `chat-ui/src/auth.js`, modify `fetchUserFamilies` to accept `userId` and `role` parameters and filter results for non-admins.

Change the function signature from:
```js
async function fetchUserFamilies(token) {
```
to:
```js
async function fetchUserFamilies(token, userId, role) {
```

After the existing line that builds the return array (the `return Object.keys(docsByFamily).sort().map(...)` block), add filtering before the return:

```js
    const allFamilies = Object.keys(docsByFamily).sort().map(fid => ({
      id: fid,
      name: fid,
      slug: fid,
      document_count: docsByFamily[fid].size
    }));

    // Ethical walls: non-admin users only see families they have access to
    if (role === 'admin' || !userId) return allFamilies;

    const { rows: accessRows } = await db.query(
      'SELECT family_id FROM user_family_access WHERE user_id = $1',
      [userId]
    );
    const allowedFamilies = new Set(accessRows.map(r => r.family_id));
    return allFamilies.filter(f => allowedFamilies.has(f.id));
```

**Step 5: Update the caller in routes/auth.js**

In `chat-ui/src/routes/auth.js`, the `GET /api/auth/families` route calls `auth.fetchUserFamilies(user.paperless_token)`. Update to pass userId and role:

Change:
```js
const families = await auth.fetchUserFamilies(user.paperless_token);
```
to:
```js
const families = await auth.fetchUserFamilies(user.paperless_token, req.user.id, req.user.role);
```

**Step 6: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npm test`
Expected: All tests pass (new auth tests + all existing 59)

**Step 7: Commit**

```
feat(ethical-walls): add userCanAccessFamily helper and filter family dropdown by access
```

---

### Task 6: Enforce family access on chat and conversation endpoints

**Files:**
- Modify: `chat-ui/src/streaming.js:54-69` (POST /api/chat — add access check)
- Modify: `chat-ui/src/api.js:15-27` (POST /api/chat — add access check)
- Modify: `chat-ui/src/routes/conversations.js:87-97` (POST / — add access check)

**Step 1: Add access check to streaming.js**

In `chat-ui/src/streaming.js`, add at the top:
```js
const { userCanAccessFamily } = require('./auth');
```

Then in the POST handler, after the `family_id` validation (after line 69: `return res.status(400).json({ error: 'family_id is required' });`), add:

```js
      // Ethical walls: verify user has access to this family
      const hasAccess = await userCanAccessFamily(userId, req.user.role, family_id);
      if (!hasAccess) {
        return res.status(403).json({
          error: 'You do not have access to this matter',
          code: 'FAMILY_ACCESS_DENIED'
        });
      }
```

**Step 2: Add access check to api.js**

In `chat-ui/src/api.js`, add at the top:
```js
const { userCanAccessFamily } = require('./auth');
```

Then in the POST /chat handler, after the `question` validation check, add:

```js
      // Ethical walls: verify user has access to this family
      const hasAccess = await userCanAccessFamily(userId, req.user.role, family_id);
      if (!hasAccess) {
        return res.status(403).json({
          error: 'You do not have access to this matter',
          code: 'FAMILY_ACCESS_DENIED'
        });
      }
```

**Step 3: Add access check to conversations.js POST**

In `chat-ui/src/routes/conversations.js`, add at the top:
```js
const { userCanAccessFamily } = require('../auth');
```

Then in the `POST /` handler, after the `family_id` validation (after the `if (!family_id)` block), add:

```js
    // Ethical walls: verify user has access to this family
    const hasAccess = await userCanAccessFamily(userId, req.user.role, family_id);
    if (!hasAccess) {
      return res.status(403).json({
        error: 'You do not have access to this matter',
        code: 'FAMILY_ACCESS_DENIED'
      });
    }
```

**Step 4: Update existing tests for conversations and api**

In `chat-ui/src/routes/conversations.test.js`, add `../auth` mock at the top (after the db mock):

```js
jest.mock('../auth', () => ({
  userCanAccessFamily: jest.fn().mockResolvedValue(true),
  verifyAccessToken: jest.fn(),
}));
```

In `chat-ui/src/api.test.js`, add `./auth` mock at the top (after the db mock):

```js
jest.mock('./auth', () => ({
  userCanAccessFamily: jest.fn().mockResolvedValue(true),
  verifyAccessToken: jest.fn(),
  redis: { on: jest.fn(), ping: jest.fn() },
}));
```

**Step 5: Add new tests for family access denial**

Add to `chat-ui/src/routes/conversations.test.js` in the `POST /api/conversations` describe block:

```js
  test('rejects conversation creation for unauthorized family (403)', async () => {
    const { userCanAccessFamily } = require('../auth');
    userCanAccessFamily.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/conversations')
      .send({ family_id: 'restricted' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FAMILY_ACCESS_DENIED');
  });
```

Add to `chat-ui/src/api.test.js` in the `POST /api/chat` describe block:

```js
  test('rejects chat for unauthorized family (403)', async () => {
    const { userCanAccessFamily } = require('./auth');
    userCanAccessFamily.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/chat')
      .send({ family_id: 'restricted', question: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FAMILY_ACCESS_DENIED');
  });
```

**Step 6: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npm test`
Expected: All tests pass (including new access denial tests)

**Step 7: Commit**

```
feat(ethical-walls): enforce family access on chat and conversation creation endpoints
```

---

### Task 7: Admin API for managing family access

**Files:**
- Create: `chat-ui/src/routes/family-access.js`
- Create: `chat-ui/src/routes/family-access.test.js`
- Modify: `chat-ui/src/index.js` (mount new route)

**Step 1: Write the tests first**

Create `chat-ui/src/routes/family-access.test.js`:

```js
const request = require('supertest');
const { createApp } = require('../test-helpers');

jest.mock('../auth', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  healthCheck: jest.fn(),
}));

const db = require('../db');
const router = require('./family-access');

const adminApp = createApp(router, '/api/admin/family-access', { auth: 'admin' });
const userApp = createApp(router, '/api/admin/family-access', { auth: 'user' });

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

describe('GET /api/admin/family-access', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns all assignments for admin', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: '1', user_id: VALID_UUID, family_id: 'morrison' }],
    });
    const res = await request(adminApp).get('/api/admin/family-access');
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp).get('/api/admin/family-access');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/family-access/:userId', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns families for a specific user', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ family_id: 'morrison' }, { family_id: 'johnson' }],
    });
    const res = await request(adminApp).get(`/api/admin/family-access/${VALID_UUID}`);
    expect(res.status).toBe(200);
    expect(res.body.families).toHaveLength(2);
  });
});

describe('POST /api/admin/family-access', () => {
  afterEach(() => jest.resetAllMocks());

  test('grants family access', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: '1', user_id: VALID_UUID, family_id: 'morrison' }],
    });
    const res = await request(adminApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID, family_id: 'morrison' });
    expect(res.status).toBe(201);
  });

  test('rejects missing fields', async () => {
    const res = await request(adminApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID });
    expect(res.status).toBe(400);
  });

  test('handles duplicate gracefully', async () => {
    db.query.mockRejectedValueOnce({ code: '23505' }); // unique violation
    const res = await request(adminApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID, family_id: 'morrison' });
    expect(res.status).toBe(409);
  });

  test('non-admin gets 403', async () => {
    const res = await request(userApp)
      .post('/api/admin/family-access')
      .send({ user_id: VALID_UUID, family_id: 'morrison' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/admin/family-access/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('revokes access', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(adminApp).delete(`/api/admin/family-access/${VALID_UUID}`);
    expect(res.status).toBe(200);
  });

  test('returns 404 for missing assignment', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(adminApp).delete(`/api/admin/family-access/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Create the route handler**

Create `chat-ui/src/routes/family-access.js`:

```js
/**
 * Family access management routes (admin only)
 * CRUD for user_family_access table (ethical walls)
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * Middleware to require admin role
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Admin access required',
      code: 'FORBIDDEN'
    });
  }
  next();
}

// All routes require admin
router.use(requireAdmin);

/**
 * GET /api/admin/family-access
 * List all family access assignments
 */
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT ufa.id, ufa.user_id, ufa.family_id, ufa.created_at,
             u.paperless_username, u.display_name,
             g.paperless_username as granted_by_username
      FROM user_family_access ufa
      JOIN users u ON u.id = ufa.user_id
      LEFT JOIN users g ON g.id = ufa.granted_by
      ORDER BY u.paperless_username, ufa.family_id
    `);
    res.json({ assignments: rows });
  } catch (err) {
    console.error('List family access error:', err);
    res.status(500).json({ error: 'Failed to list assignments', code: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/admin/family-access/:userId
 * List families accessible by a specific user
 */
router.get('/:userId', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT family_id, created_at FROM user_family_access WHERE user_id = $1 ORDER BY family_id',
      [req.params.userId]
    );
    res.json({ families: rows });
  } catch (err) {
    console.error('Get user family access error:', err);
    res.status(500).json({ error: 'Failed to get user access', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/admin/family-access
 * Grant a user access to a family
 * Body: { user_id, family_id }
 */
router.post('/', async (req, res) => {
  try {
    const { user_id, family_id } = req.body;
    if (!user_id || !family_id) {
      return res.status(400).json({
        error: 'user_id and family_id are required',
        code: 'VALIDATION_ERROR'
      });
    }
    const { rows } = await db.query(
      `INSERT INTO user_family_access (user_id, family_id, granted_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [user_id, family_id, req.user.id]
    );
    res.status(201).json({ assignment: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'User already has access to this family',
        code: 'DUPLICATE'
      });
    }
    console.error('Grant family access error:', err);
    res.status(500).json({ error: 'Failed to grant access', code: 'SERVER_ERROR' });
  }
});

/**
 * DELETE /api/admin/family-access/:id
 * Revoke a family access assignment
 */
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM user_family_access WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Assignment not found', code: 'NOT_FOUND' });
    }
    res.json({ message: 'Access revoked' });
  } catch (err) {
    console.error('Revoke family access error:', err);
    res.status(500).json({ error: 'Failed to revoke access', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
```

**Step 3: Mount the route in index.js**

In `chat-ui/src/index.js`, add the import near the top with the other route imports:

```js
const familyAccessRoutes = require('./routes/family-access');
```

And mount it after the audit routes line (`app.use('/api/audit', auditRoutes);`):

```js
// Protected family access admin routes
app.use('/api/admin/family-access', requireAuth, familyAccessRoutes);
```

**Step 4: Run tests**

Run: `cd /workspace/mattervault/chat-ui && npm test`
Expected: All tests pass

**Step 5: Commit**

```
feat(ethical-walls): add admin API for managing per-family user access
```

---

### Task 8: Update docs and run full suite

**Files:**
- Modify: `CLAUDE.md` (update Access Model section)
- Modify: `docs/NEXT_STEPS.md` (move items to completed)

**Step 1: Update CLAUDE.md Access Model section**

In `CLAUDE.md`, find the "Access Model" section and update:

Replace:
```
**Open access**: Any authenticated Paperless user can query any family's documents. Family is selected per-conversation via dropdown. This is appropriate for small, trusted teams.
```

With:
```
**Per-family access control (ethical walls)**: Admins see all families. Regular users only see families assigned to them via the admin panel (`/api/admin/family-access`). Family is selected per-conversation via dropdown. Access is enforced at the API layer (family dropdown, chat endpoints, conversation creation). Users with no assigned families see an empty dropdown with a message to contact their administrator.
```

**Step 2: Update NEXT_STEPS.md**

Move "Production hardening" and "Per-Family Access Control" from potential to completed section. Remove from decision matrix.

**Step 3: Run full test suite**

Run: `cd /workspace/mattervault/chat-ui && npm test -- --verbose`
Expected: All tests pass

**Step 4: Commit**

```
docs: update access model for ethical walls, move TLS + access control to completed
```

---

## Summary

| Task | Feature | What |
|------|---------|------|
| 1 | TLS | Caddyfile + docker-compose.tls.yml overlay |
| 2 | TLS | trust-proxy for client IPs behind Caddy |
| 3 | TLS | Client DNS setup script (optional subdomain upgrade) |
| 4 | Ethical Walls | Database migration (user_family_access table) |
| 5 | Ethical Walls | userCanAccessFamily helper + filter family dropdown |
| 6 | Ethical Walls | Enforce access on chat + conversation endpoints |
| 7 | Ethical Walls | Admin API for managing family assignments |
| 8 | Docs | Update CLAUDE.md, NEXT_STEPS.md |
