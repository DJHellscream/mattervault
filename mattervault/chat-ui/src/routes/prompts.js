/**
 * Prompt template routes
 * CRUD + reorder endpoints for prompt library (Quick Actions)
 */

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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

/**
 * GET /api/prompts
 * List prompts (any authenticated user)
 * Admin sees all (including disabled), regular users see only enabled
 */
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
    res.status(500).json({
      error: 'Failed to fetch prompts',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * POST /api/prompts
 * Create new prompt (admin only)
 */
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, icon, prompt_text } = req.body;
    if (!title || !prompt_text) {
      return res.status(400).json({
        error: 'Title and prompt_text are required',
        code: 'VALIDATION_ERROR'
      });
    }
    const maxResult = await db.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order FROM prompt_templates'
    );
    const nextOrder = maxResult.rows[0].next_order;
    const result = await db.query(
      `INSERT INTO prompt_templates (title, description, icon, prompt_text, sort_order, is_default, created_by)
       VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING *`,
      [title, description || '', icon || 'file-text', prompt_text, nextOrder, req.user.id]
    );
    res.status(201).json({ prompt: result.rows[0] });
  } catch (err) {
    console.error('Create prompt error:', err);
    res.status(500).json({
      error: 'Failed to create prompt',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * PUT /api/prompts/:id
 * Update prompt (admin only)
 */
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, icon, prompt_text, enabled } = req.body;
    if (!title || !prompt_text) {
      return res.status(400).json({
        error: 'Title and prompt_text are required',
        code: 'VALIDATION_ERROR'
      });
    }
    const result = await db.query(
      `UPDATE prompt_templates SET title = $1, description = $2, icon = $3, prompt_text = $4, enabled = $5, updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [title, description || '', icon || 'file-text', prompt_text, enabled !== false, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Prompt not found',
        code: 'NOT_FOUND'
      });
    }
    res.json({ prompt: result.rows[0] });
  } catch (err) {
    console.error('Update prompt error:', err);
    res.status(500).json({
      error: 'Failed to update prompt',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * DELETE /api/prompts/:id
 * Delete prompt (admin only, blocks defaults)
 */
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await db.query(
      'SELECT is_default FROM prompt_templates WHERE id = $1',
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({
        error: 'Prompt not found',
        code: 'NOT_FOUND'
      });
    }
    if (check.rows[0].is_default) {
      return res.status(400).json({
        error: 'Cannot delete default prompts. Disable them instead.',
        code: 'VALIDATION_ERROR'
      });
    }
    await db.query('DELETE FROM prompt_templates WHERE id = $1', [id]);
    res.json({ message: 'Prompt deleted' });
  } catch (err) {
    console.error('Delete prompt error:', err);
    res.status(500).json({
      error: 'Failed to delete prompt',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * PATCH /api/prompts/reorder
 * Bulk update sort_order (admin only)
 */
router.patch('/reorder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({
        error: 'Order array is required',
        code: 'VALIDATION_ERROR'
      });
    }
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
    res.status(500).json({
      error: 'Failed to reorder prompts',
      code: 'SERVER_ERROR'
    });
  }
});

module.exports = router;
