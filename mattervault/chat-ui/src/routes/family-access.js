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
