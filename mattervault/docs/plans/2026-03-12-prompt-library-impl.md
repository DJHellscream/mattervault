# Prompt Library (Quick Actions) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Quick Actions" prompt library to Mattervault — pre-built prompts on the welcome screen and input area, with admin CRUD management including drag-to-reorder and icon picker.

**Architecture:** New `prompt_templates` table seeded with 5 defaults. Express CRUD routes under `/api/prompts`. Chat UI loads prompts on page load, renders as welcome cards + input-area popup menu. Separate admin page (`prompts.html`) for management. Quick actions trigger `sendMessage()` by setting `questionInput.value`.

**Tech Stack:** PostgreSQL (migration), Express (API routes), vanilla JS/HTML/CSS (frontend), SortableJS CDN (drag-to-reorder on admin page)

**Design doc:** `docs/plans/2026-03-12-prompt-library-design.md`

---

## Task 1: Database Migration

**Files:**
- Create: `chat-ui/migrations/007_prompt_templates.sql`

**Step 1: Write the migration**

```sql
-- Prompt templates for Quick Actions
CREATE TABLE IF NOT EXISTS prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(100) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  icon VARCHAR(50) NOT NULL DEFAULT 'file-text',
  prompt_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_sort ON prompt_templates (sort_order);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_enabled ON prompt_templates (enabled);

-- Seed 5 default prompts
INSERT INTO prompt_templates (title, description, icon, prompt_text, sort_order, is_default, enabled)
VALUES
  ('Summarize Key Terms', 'Structured summary of provisions, parties, dates, and obligations', 'file-text', 'Provide a structured summary of the key terms across all documents, including parties, dates, obligations, and notable provisions.', 1, true, true),
  ('Flag Issues & Concerns', 'Identify ambiguous language, conflicts, and gaps needing review', 'alert-triangle', 'Review all documents and identify potential issues, risks, or concerns such as ambiguous language, missing contingencies, conflicting terms, or gaps that may need attorney review.', 2, true, true),
  ('List All Documents', 'Overview of every document with type, date, and purpose', 'list', 'List every document in this family''s vault with its type, date, and a brief description of its purpose.', 3, true, true),
  ('Timeline of Events', 'Chronological timeline of dates and milestones with citations', 'clock', 'Extract a chronological timeline of all significant events, dates, and milestones from the documents, citing the source document for each entry.', 4, true, true),
  ('Identify Parties & Roles', 'Every person and entity with their roles and relationships', 'users', 'Identify every person and entity mentioned across all documents, their roles, which documents they appear in, and relationships between them.', 5, true, true)
ON CONFLICT DO NOTHING;
```

**Step 2: Verify migration runs on container restart**

Run: `docker compose build chat-ui && docker compose up -d chat-ui`
Then: `docker logs matterchat 2>&1 | grep -i migrat`
Expected: "Running migration: 007_prompt_templates.sql" (or similar success message)

**Step 3: Verify table and data exist**

Run: `docker exec matterdb-chatui psql -U chatui -d chatui -c "SELECT id, title, icon, sort_order, is_default FROM prompt_templates ORDER BY sort_order;"`
Expected: 5 rows with the default prompts

**Step 4: Commit**

```bash
git add chat-ui/migrations/007_prompt_templates.sql
git commit -m "feat(prompts): add prompt_templates migration with 5 defaults"
```

---

## Task 2: API Routes — CRUD + Reorder

**Files:**
- Create: `chat-ui/src/routes/prompts.js`
- Modify: `chat-ui/src/index.js` (add route mounting, ~line 6 for require, ~line 61 for app.use)

**Step 1: Create the prompts route file**

Create `chat-ui/src/routes/prompts.js` following the pattern in `chat-ui/src/routes/audit.js`:

```javascript
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
  next();
}

// GET /api/prompts - List enabled prompts (any authenticated user)
// Admin sees all (including disabled), regular users see only enabled
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const query = isAdmin
      ? 'SELECT * FROM prompt_templates ORDER BY sort_order ASC'
      : 'SELECT * FROM prompt_templates WHERE enabled = true ORDER BY sort_order ASC';
    const result = await db.query(query);
    res.json({ prompts: result.rows });
  } catch (err) {
    console.error('List prompts error:', err);
    res.status(500).json({ error: 'Failed to fetch prompts', code: 'SERVER_ERROR' });
  }
});

// POST /api/prompts - Create new prompt (admin only)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, icon, prompt_text } = req.body;

    if (!title || !prompt_text) {
      return res.status(400).json({ error: 'Title and prompt_text are required', code: 'VALIDATION_ERROR' });
    }

    // Get next sort_order
    const maxResult = await db.query('SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order FROM prompt_templates');
    const nextOrder = maxResult.rows[0].next_order;

    const result = await db.query(
      `INSERT INTO prompt_templates (title, description, icon, prompt_text, sort_order, is_default, created_by)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       RETURNING *`,
      [title, description || '', icon || 'file-text', prompt_text, nextOrder, req.user.id]
    );

    res.status(201).json({ prompt: result.rows[0] });
  } catch (err) {
    console.error('Create prompt error:', err);
    res.status(500).json({ error: 'Failed to create prompt', code: 'SERVER_ERROR' });
  }
});

// PUT /api/prompts/:id - Update prompt (admin only)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, icon, prompt_text, enabled } = req.body;

    if (!title || !prompt_text) {
      return res.status(400).json({ error: 'Title and prompt_text are required', code: 'VALIDATION_ERROR' });
    }

    const result = await db.query(
      `UPDATE prompt_templates
       SET title = $1, description = $2, icon = $3, prompt_text = $4, enabled = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [title, description || '', icon || 'file-text', prompt_text, enabled !== false, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prompt not found', code: 'NOT_FOUND' });
    }

    res.json({ prompt: result.rows[0] });
  } catch (err) {
    console.error('Update prompt error:', err);
    res.status(500).json({ error: 'Failed to update prompt', code: 'SERVER_ERROR' });
  }
});

// DELETE /api/prompts/:id - Delete prompt (admin only, blocks defaults)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if default
    const check = await db.query('SELECT is_default FROM prompt_templates WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Prompt not found', code: 'NOT_FOUND' });
    }
    if (check.rows[0].is_default) {
      return res.status(400).json({ error: 'Cannot delete default prompts. Disable them instead.', code: 'VALIDATION_ERROR' });
    }

    await db.query('DELETE FROM prompt_templates WHERE id = $1', [id]);
    res.json({ message: 'Prompt deleted' });
  } catch (err) {
    console.error('Delete prompt error:', err);
    res.status(500).json({ error: 'Failed to delete prompt', code: 'SERVER_ERROR' });
  }
});

// PATCH /api/prompts/reorder - Bulk update sort_order (admin only)
router.patch('/reorder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { order } = req.body; // Array of { id, sort_order }

    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'Order array is required', code: 'VALIDATION_ERROR' });
    }

    // Update each in a transaction
    await db.query('BEGIN');
    for (const item of order) {
      await db.query(
        'UPDATE prompt_templates SET sort_order = $1, updated_at = NOW() WHERE id = $2',
        [item.sort_order, item.id]
      );
    }
    await db.query('COMMIT');

    res.json({ message: 'Order updated' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Reorder prompts error:', err);
    res.status(500).json({ error: 'Failed to reorder prompts', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
```

**Step 2: Mount the route in `chat-ui/src/index.js`**

Add require at ~line 9 (after other route requires):
```javascript
const promptsRoutes = require('./routes/prompts');
```

Add app.use at ~line 61 (after audit routes):
```javascript
app.use('/api/prompts', promptsRoutes);
```

**Step 3: Rebuild and test the API**

Run: `docker compose build chat-ui && docker compose up -d chat-ui`

Test GET (should return 5 prompts):
```bash
# Get a token first
TOKEN=$(curl -s -X POST http://localhost:3007/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"<password>"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")

# List prompts
curl -s http://localhost:3007/api/prompts -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: `{ "prompts": [ ... 5 items ... ] }`

**Step 4: Commit**

```bash
git add chat-ui/src/routes/prompts.js chat-ui/src/index.js
git commit -m "feat(prompts): add CRUD + reorder API routes"
```

---

## Task 3: Chat UI — Welcome Screen Quick Action Cards

**Files:**
- Modify: `chat-ui/public/index.html` (~lines 572-581 welcome section, ~lines 820-840 init JS)
- Modify: `chat-ui/public/style.css` (add quick-action styles after welcome-message styles ~line 679)

**Step 1: Add quick action card styles to `style.css`**

Add after the `.welcome-message p` block (~line 679):

```css
/* Quick Action Cards */
.quick-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  max-width: 800px;
  width: 100%;
  margin-top: 12px;
}

.quick-action-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.quick-action-card:hover:not(.disabled) {
  border-color: var(--border-glow);
  background: rgba(20, 28, 48, 0.8);
  transform: translateY(-2px);
}

.quick-action-card.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.quick-action-card .qa-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 212, 170, 0.1);
  border-radius: 8px;
  color: var(--accent-teal);
}

.quick-action-card .qa-content {
  flex: 1;
  min-width: 0;
}

.quick-action-card .qa-title {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.quick-action-card .qa-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.4;
}

@media (max-width: 768px) {
  .quick-actions {
    grid-template-columns: 1fr;
  }
}
```

**Step 2: Add the icon SVG map and prompt loading JS in `index.html`**

Add in the `<script>` section, before the `init()` function (~before line 820):

```javascript
// Quick Actions state
let quickActionPrompts = [];

// SVG icon map for quick actions
const QA_ICONS = {
  'file-text': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
  'alert-triangle': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  'list': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  'clock': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  'users': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  'search': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  'shield': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  'bookmark': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  'scale': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="3" x2="12" y2="21"/><path d="M17 8l-5-5-5 5"/><path d="M3 18h18"/></svg>',
  'folder': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  'edit': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  'zap': '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
};

function getIconSvg(iconName) {
  return QA_ICONS[iconName] || QA_ICONS['file-text'];
}

// Load quick action prompts from API
async function loadQuickActions() {
  try {
    const res = await authFetch('/api/prompts');
    if (!res.ok) return;
    const data = await res.json();
    quickActionPrompts = data.prompts || [];
    renderWelcomeQuickActions();
  } catch (err) {
    console.error('Failed to load quick actions:', err);
  }
}

// Render quick action cards in the welcome message
function renderWelcomeQuickActions() {
  const welcome = document.querySelector('.welcome-message');
  if (!welcome || quickActionPrompts.length === 0) return;

  // Remove existing quick actions if any
  const existing = welcome.querySelector('.quick-actions');
  if (existing) existing.remove();

  const grid = document.createElement('div');
  grid.className = 'quick-actions';

  quickActionPrompts.forEach(prompt => {
    const card = document.createElement('button');
    card.className = 'quick-action-card' + (selectedFamily ? '' : ' disabled');
    card.innerHTML = `
      <div class="qa-icon">${getIconSvg(prompt.icon)}</div>
      <div class="qa-content">
        <div class="qa-title">${escapeHtml(prompt.title)}</div>
        <div class="qa-desc">${escapeHtml(prompt.description)}</div>
      </div>
    `;
    card.addEventListener('click', () => {
      if (!selectedFamily) return;
      fireQuickAction(prompt.prompt_text);
    });
    grid.appendChild(card);
  });

  welcome.appendChild(grid);
}

// Fire a quick action — sets input and sends
function fireQuickAction(promptText) {
  if (!selectedFamily || isLoading) return;
  questionInput.value = promptText;
  sendMessage();
}
```

**Step 3: Call `loadQuickActions()` during init**

In the `init()` function, after `loadFamilies()` completes and families are rendered, add:

```javascript
await loadQuickActions();
```

**Step 4: Update quick action card state when family changes**

In the `onFamilyChange()` function, after the existing logic, add:

```javascript
// Update quick action cards enabled state
document.querySelectorAll('.quick-action-card').forEach(card => {
  if (selectedFamily) {
    card.classList.remove('disabled');
  } else {
    card.classList.add('disabled');
  }
});
```

**Step 5: Include quick actions in `startNewChat()` welcome message rebuild**

In `startNewChat()` (~line 973), after the welcome message HTML is set, add:

```javascript
renderWelcomeQuickActions();
```

**Step 6: Rebuild and verify**

Run: `docker compose build chat-ui && docker compose up -d chat-ui`
Open: http://localhost:3007

Expected: Welcome screen shows 5 quick action cards below the welcome text. Cards are dimmed until a family is selected. Selecting a family enables them. Clicking one sends the prompt.

**Step 7: Commit**

```bash
git add chat-ui/public/index.html chat-ui/public/style.css
git commit -m "feat(prompts): add quick action cards to welcome screen"
```

---

## Task 4: Chat UI — Input Area Quick Actions Menu

**Files:**
- Modify: `chat-ui/public/index.html` (~line 584 input area HTML, JS section)
- Modify: `chat-ui/public/style.css` (add input quick-actions menu styles)

**Step 1: Add the lightning-bolt button and menu HTML**

In `index.html`, modify the `.input-area` section (~line 584). Add a quick-actions button + menu before the `.input-wrapper`:

```html
<div class="input-area">
  <div class="input-actions-row">
    <div class="quick-actions-dropdown" id="quickActionsDropdown">
      <button class="quick-actions-btn" id="quickActionsBtn" title="Quick Actions" disabled>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
      </button>
      <div class="quick-actions-menu" id="quickActionsMenu">
        <!-- Populated by JS -->
      </div>
    </div>
    <div class="input-wrapper">
      <input type="text" id="questionInput" placeholder="Type your question..." disabled>
      <button id="sendBtn" disabled>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
        </svg>
      </button>
    </div>
  </div>
  <div class="input-hint" id="inputHint">Select a family to start chatting</div>
</div>
```

**Step 2: Add input-area quick actions styles to `style.css`**

Add after the quick-action-card styles:

```css
/* Input area quick actions dropdown */
.input-actions-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.input-actions-row .input-wrapper {
  flex: 1;
}

.quick-actions-dropdown {
  position: relative;
}

.quick-actions-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-actions-btn:hover:not(:disabled) {
  border-color: var(--border-glow);
  color: var(--accent-teal);
  background: rgba(0, 212, 170, 0.1);
}

.quick-actions-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.quick-actions-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 8px;
  background: var(--bg-surface);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 6px;
  min-width: 280px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(8px);
  transition: all 0.2s ease;
  z-index: 50;
}

.quick-actions-dropdown.open .quick-actions-menu {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.quick-actions-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: transparent;
  border: none;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  color: var(--text-primary);
  font-family: 'Outfit', sans-serif;
  font-size: 0.85rem;
  text-align: left;
  transition: all 0.15s ease;
}

.quick-actions-menu-item:hover {
  background: rgba(0, 212, 170, 0.1);
  color: var(--accent-teal);
}

.quick-actions-menu-item .qa-menu-icon {
  flex-shrink: 0;
  opacity: 0.7;
  color: var(--accent-teal);
}

.quick-actions-menu-item:hover .qa-menu-icon {
  opacity: 1;
}

@media (max-width: 480px) {
  .quick-actions-btn {
    width: 40px;
    border-radius: 12px;
  }

  .quick-actions-menu {
    min-width: 240px;
  }
}
```

**Step 3: Add JS to populate and toggle the menu**

In the `<script>` section, add after the `loadQuickActions` function:

```javascript
// Render the input-area quick actions menu
function renderQuickActionsMenu() {
  const menu = document.getElementById('quickActionsMenu');
  if (!menu) return;

  menu.innerHTML = quickActionPrompts.map(prompt => `
    <button class="quick-actions-menu-item" data-prompt="${escapeHtml(prompt.prompt_text)}">
      <span class="qa-menu-icon">${getIconSvg(prompt.icon)}</span>
      ${escapeHtml(prompt.title)}
    </button>
  `).join('');

  // Add click handlers
  menu.querySelectorAll('.quick-actions-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const promptText = item.dataset.prompt;
      quickActionsDropdown.classList.remove('open');
      fireQuickAction(promptText);
    });
  });
}

// Toggle quick actions dropdown
const quickActionsDropdown = document.getElementById('quickActionsDropdown');
const quickActionsBtn = document.getElementById('quickActionsBtn');

quickActionsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (quickActionsBtn.disabled) return;
  quickActionsDropdown.classList.toggle('open');
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (!quickActionsDropdown.contains(e.target)) {
    quickActionsDropdown.classList.remove('open');
  }
});
```

**Step 4: Enable/disable the quick actions button with family selector**

In the `onFamilyChange()` function, alongside the existing `questionInput.disabled` and `sendBtn.disabled` logic, add:

```javascript
quickActionsBtn.disabled = !selectedFamily;
```

Also add this in the initial disabled state (when no family selected).

**Step 5: Call `renderQuickActionsMenu()` after loading prompts**

In `loadQuickActions()`, after `renderWelcomeQuickActions()`, add:

```javascript
renderQuickActionsMenu();
```

**Step 6: Rebuild and verify**

Run: `docker compose build chat-ui && docker compose up -d chat-ui`

Expected: Lightning bolt button appears left of input. Disabled until family selected. Click opens popup menu with 5 actions. Clicking an action sends it. Menu opens upward (above input).

**Step 7: Commit**

```bash
git add chat-ui/public/index.html chat-ui/public/style.css
git commit -m "feat(prompts): add quick actions popup menu in input area"
```

---

## Task 5: Admin Page — `prompts.html`

**Files:**
- Create: `chat-ui/public/prompts.html`
- Modify: `chat-ui/public/index.html` (~line 560, add admin link for Prompt Library)

**Step 1: Add "Prompt Library" admin link in `index.html`**

In the user menu section (~line 565), after the existing audit admin link, add:

```html
<a href="/prompts" class="admin-link" id="promptsLink">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
  <span>Prompt Library</span>
</a>
```

In the JS init section where admin link visibility is set (~line 835), add:

```javascript
const promptsLink = document.getElementById('promptsLink');
if (promptsLink && currentUser.role === 'admin') {
  promptsLink.classList.add('visible');
}
```

**Step 2: Create `prompts.html`**

Create `chat-ui/public/prompts.html` — a full admin page following the `audit.html` pattern. This is a large file. Key sections:

- Same HTML boilerplate as audit.html (fonts, meta, body bg)
- Page-specific `<style>` block with `body { overflow: auto; }` override
- Auth check pattern (localStorage/sessionStorage → admin role check → show main content)
- Header: "Prompt Library" title, admin badge, back-to-chat link
- "Add New" button in header
- Sortable list of prompt cards with: drag handle, icon, title, description, enabled toggle, edit button, delete button
- Create/edit modal with: title input, description input, icon picker grid, prompt_text textarea, save/cancel buttons
- SortableJS loaded from CDN: `https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js`
- Drag-to-reorder calls `PATCH /api/prompts/reorder` on drop
- Delete shows confirmation, blocks for `is_default` items
- Icon picker: grid of clickable icons from the same preset list (file-text, alert-triangle, list, clock, users, search, shield, bookmark, scale, folder, edit, zap)

The full HTML for this file is large (~800 lines). Key implementation details:

**Icon picker grid in modal:**
```html
<div class="icon-picker" id="iconPicker">
  <!-- JS renders clickable icon buttons from QA_ICONS map -->
</div>
```

**Sortable initialization:**
```javascript
const sortable = new Sortable(promptsList, {
  animation: 150,
  handle: '.drag-handle',
  ghostClass: 'sortable-ghost',
  onEnd: async function() {
    const items = promptsList.querySelectorAll('.prompt-card');
    const order = Array.from(items).map((item, index) => ({
      id: item.dataset.id,
      sort_order: index + 1
    }));
    await api('/api/prompts/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ order })
    });
  }
});
```

**Enabled toggle:**
```javascript
async function toggleEnabled(id, currentState) {
  const prompt = prompts.find(p => p.id === id);
  await api(`/api/prompts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ ...prompt, enabled: !currentState })
  });
  await loadPrompts();
}
```

**Step 3: Rebuild and verify**

Run: `docker compose build chat-ui && docker compose up -d chat-ui`

Expected:
- Admin user sees "Prompt Library" link in user menu
- `/prompts` page shows 5 default prompts in a sortable list
- Can drag to reorder
- Can toggle enabled/disabled
- Can edit title/description/icon/prompt via modal
- Can add new custom prompts
- Cannot delete default prompts (button disabled or warning)
- Can delete custom prompts

**Step 4: Commit**

```bash
git add chat-ui/public/prompts.html chat-ui/public/index.html
git commit -m "feat(prompts): add admin prompt library management page"
```

---

## Task 6: Final Integration Testing & Cleanup

**Step 1: Test full flow end-to-end**

1. Log in as admin → see "Prompt Library" in user menu
2. Visit `/prompts` → see 5 default prompts
3. Add a custom prompt ("Check Compliance" with shield icon)
4. Drag it to position 2
5. Disable "Timeline of Events"
6. Go back to chat → welcome screen shows 5 cards (the new one in position 2, Timeline gone)
7. Select a family → cards become active
8. Click "Summarize Key Terms" → sends prompt, gets response
9. In an active conversation, click lightning bolt → see 5 actions in popup
10. Click "Check Compliance" → sends prompt
11. Log in as non-admin → see cards but no admin links
12. Verify non-admin cannot access `/prompts` page (redirects to access denied)

**Step 2: Test mobile responsiveness**

- Welcome cards stack single-column on small screens
- Lightning bolt button and menu work on mobile
- Admin page is usable on tablet

**Step 3: Commit final**

```bash
git add -A
git commit -m "feat(prompts): prompt library complete - quick actions + admin management"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Database migration + seed | `migrations/007_prompt_templates.sql` |
| 2 | CRUD + reorder API routes | `src/routes/prompts.js`, `src/index.js` |
| 3 | Welcome screen cards | `public/index.html`, `public/style.css` |
| 4 | Input area popup menu | `public/index.html`, `public/style.css` |
| 5 | Admin management page | `public/prompts.html`, `public/index.html` |
| 6 | Integration testing | All files |
