/**
 * Conversations routes
 * CRUD operations for conversation history with user isolation
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * GET /api/conversations
 * List user's conversations (paginated, sorted by updated_at desc)
 * Query params: limit (default 20), offset (default 0), family_id (optional filter)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const familyId = req.query.family_id;

    let query = `
      SELECT
        c.id,
        c.family_id,
        c.title,
        c.created_at,
        c.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count
      FROM conversations c
      WHERE c.user_id = $1
    `;
    const params = [userId];

    if (familyId) {
      query += ` AND c.family_id = $2`;
      params.push(familyId);
    }

    query += ` ORDER BY c.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await db.query(query, params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) FROM conversations WHERE user_id = $1';
    const countParams = [userId];
    if (familyId) {
      countQuery += ' AND family_id = $2';
      countParams.push(familyId);
    }
    const { rows: countRows } = await db.query(countQuery, countParams);
    const total = parseInt(countRows[0].count);

    res.json({
      conversations: rows.map(row => ({
        id: row.id,
        familyId: row.family_id,
        title: row.title,
        messageCount: parseInt(row.message_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + rows.length < total
      }
    });
  } catch (err) {
    console.error('Error listing conversations:', err);
    res.status(500).json({
      error: 'Failed to list conversations',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * POST /api/conversations
 * Create a new conversation
 * Body: { family_id, title? }
 */
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { family_id, title } = req.body;

    if (!family_id) {
      return res.status(400).json({
        error: 'family_id is required',
        code: 'VALIDATION_ERROR'
      });
    }

    const { rows } = await db.query(
      `INSERT INTO conversations (user_id, family_id, title)
       VALUES ($1, $2, $3)
       RETURNING id, family_id, title, created_at, updated_at`,
      [userId, family_id, title || null]
    );

    const conv = rows[0];
    res.status(201).json({
      id: conv.id,
      familyId: conv.family_id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at
    });
  } catch (err) {
    console.error('Error creating conversation:', err);
    res.status(500).json({
      error: 'Failed to create conversation',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * GET /api/conversations/:id
 * Get conversation with all messages
 */
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.id;

    // Get conversation (verify ownership)
    const { rows: convRows } = await db.query(
      `SELECT id, family_id, title, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (convRows.length === 0) {
      return res.status(404).json({
        error: 'Conversation not found',
        code: 'NOT_FOUND'
      });
    }

    const conv = convRows[0];

    // Get messages
    const { rows: msgRows } = await db.query(
      `SELECT id, role, content, citations, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId]
    );

    res.json({
      id: conv.id,
      familyId: conv.family_id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      messages: msgRows.map(msg => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        citations: msg.citations,
        createdAt: msg.created_at
      }))
    });
  } catch (err) {
    console.error('Error fetching conversation:', err);
    res.status(500).json({
      error: 'Failed to fetch conversation',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * PATCH /api/conversations/:id
 * Update conversation title
 * Body: { title }
 */
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.id;
    const { title } = req.body;

    if (title === undefined) {
      return res.status(400).json({
        error: 'title is required',
        code: 'VALIDATION_ERROR'
      });
    }

    const { rows, rowCount } = await db.query(
      `UPDATE conversations
       SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, family_id, title, created_at, updated_at`,
      [title, conversationId, userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({
        error: 'Conversation not found',
        code: 'NOT_FOUND'
      });
    }

    const conv = rows[0];
    res.json({
      id: conv.id,
      familyId: conv.family_id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at
    });
  } catch (err) {
    console.error('Error updating conversation:', err);
    res.status(500).json({
      error: 'Failed to update conversation',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * DELETE /api/conversations/:id
 * Delete conversation (cascade deletes messages)
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.id;

    const { rowCount } = await db.query(
      `DELETE FROM conversations
       WHERE id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (rowCount === 0) {
      return res.status(404).json({
        error: 'Conversation not found',
        code: 'NOT_FOUND'
      });
    }

    res.json({ message: 'Conversation deleted successfully' });
  } catch (err) {
    console.error('Error deleting conversation:', err);
    res.status(500).json({
      error: 'Failed to delete conversation',
      code: 'SERVER_ERROR'
    });
  }
});

module.exports = router;
