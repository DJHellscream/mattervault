/**
 * Admin user listing routes
 * Returns all users for the admin console
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
 * GET /api/admin/users
 * List all users (for admin console)
 */
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, paperless_username, display_name, role, created_at
      FROM users
      ORDER BY role ASC, paperless_username ASC
    `);
    res.json({ users: rows });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
