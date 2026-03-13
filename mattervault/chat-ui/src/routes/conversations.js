/**
 * Conversations routes
 * CRUD operations for conversation history with user isolation
 */

const express = require('express');
const FormData = require('form-data');
const { userCanAccessFamily } = require('../auth');
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

    // Ethical walls: verify user has access to this family
    const hasAccess = await userCanAccessFamily(userId, req.user.role, family_id);
    if (!hasAccess) {
      return res.status(403).json({
        error: 'You do not have access to this matter',
        code: 'FAMILY_ACCESS_DENIED'
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

/**
 * GET /api/conversations/:id/export
 * Export conversation as Markdown or PDF
 * Query params: format (markdown|pdf, default: markdown)
 */
router.get('/:id/export', async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.id;
    const format = req.query.format || 'markdown';

    // Validate format
    if (!['markdown', 'pdf'].includes(format)) {
      return res.status(400).json({
        error: 'Invalid format. Use "markdown" or "pdf"',
        code: 'VALIDATION_ERROR'
      });
    }

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

    // Generate markdown content
    const markdownContent = generateMarkdown(conv, msgRows);

    if (format === 'markdown') {
      // Return markdown file
      const filename = sanitizeFilename(conv.title || 'conversation') + '.md';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(markdownContent);
    }

    // For PDF, convert HTML via Gotenberg
    const htmlContent = generateHtml(conv, msgRows);

    try {
      const pdfBuffer = await convertHtmlToPdf(htmlContent);
      const filename = sanitizeFilename(conv.title || 'conversation') + '.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfBuffer);
    } catch (pdfErr) {
      console.error('PDF conversion error:', pdfErr);
      return res.status(500).json({
        error: 'Failed to generate PDF. Gotenberg service may be unavailable.',
        code: 'PDF_CONVERSION_ERROR'
      });
    }
  } catch (err) {
    console.error('Error exporting conversation:', err);
    res.status(500).json({
      error: 'Failed to export conversation',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * Generate markdown content from conversation
 */
function generateMarkdown(conv, messages) {
  const lines = [];

  // Header
  lines.push(`# Conversation: ${conv.title || 'Untitled'}`);
  lines.push(`**Date:** ${formatDate(conv.created_at)}`);
  lines.push(`**Family:** ${conv.family_id || 'N/A'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Messages
  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push('## You');
      lines.push(msg.content || '');
    } else if (msg.role === 'assistant') {
      lines.push('## Mattervault');
      lines.push(msg.content || '');

      // Add citations if available
      if (msg.citations && Array.isArray(msg.citations) && msg.citations.length > 0) {
        lines.push('');
        const citationList = msg.citations.map(c => {
          if (typeof c === 'string') return c;
          return c.title || c.filename || c.document_title || 'Unknown source';
        }).join(', ');
        lines.push(`*Sources: ${citationList}*`);
      }
    } else if (msg.role === 'system') {
      lines.push('## System');
      lines.push(`*${msg.content || ''}*`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate styled HTML content from conversation for PDF export
 */
function generateHtml(conv, messages) {
  const messagesHtml = messages.map(msg => {
    let roleLabel = 'System';
    let roleClass = 'system';

    if (msg.role === 'user') {
      roleLabel = 'You';
      roleClass = 'user';
    } else if (msg.role === 'assistant') {
      roleLabel = 'Mattervault';
      roleClass = 'assistant';
    }

    // Escape HTML in content
    const content = escapeHtml(msg.content || '').replace(/\n/g, '<br>');

    // Format citations
    let citationsHtml = '';
    if (msg.role === 'assistant' && msg.citations && Array.isArray(msg.citations) && msg.citations.length > 0) {
      const citationList = msg.citations.map(c => {
        if (typeof c === 'string') return escapeHtml(c);
        return escapeHtml(c.title || c.filename || c.document_title || 'Unknown source');
      }).join(', ');
      citationsHtml = `<div class="citations"><em>Sources: ${citationList}</em></div>`;
    }

    return `
      <div class="message ${roleClass}">
        <div class="message-header">${roleLabel}</div>
        <div class="message-content">${content}</div>
        ${citationsHtml}
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(conv.title || 'Conversation')}</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #ffffff;
      color: #1a1a2e;
      line-height: 1.6;
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
    }

    .header {
      border-bottom: 2px solid #0a0e1a;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }

    .header h1 {
      font-size: 24px;
      font-weight: 600;
      color: #0a0e1a;
      margin-bottom: 10px;
    }

    .header .meta {
      font-size: 14px;
      color: #666;
    }

    .header .meta span {
      margin-right: 20px;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .message {
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
    }

    .message.user {
      background: #e8f4fc;
      border-color: #b8d4e8;
    }

    .message.assistant {
      background: #e8f8f4;
      border-color: #b8e8dc;
    }

    .message.system {
      background: #f5f5f5;
      border-color: #e0e0e0;
      font-style: italic;
    }

    .message-header {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .message.user .message-header {
      color: #2563eb;
    }

    .message.assistant .message-header {
      color: #059669;
    }

    .message.system .message-header {
      color: #6b7280;
    }

    .message-content {
      font-size: 14px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .citations {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(0, 0, 0, 0.1);
      font-size: 12px;
      color: #059669;
    }

    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(conv.title || 'Conversation')}</h1>
    <div class="meta">
      <span><strong>Date:</strong> ${formatDate(conv.created_at)}</span>
      <span><strong>Family:</strong> ${escapeHtml(conv.family_id || 'N/A')}</span>
    </div>
  </div>

  <div class="messages">
    ${messagesHtml}
  </div>

  <div class="footer">
    Exported from Mattervault on ${formatDate(new Date())}
  </div>
</body>
</html>`;
}

/**
 * Convert HTML to PDF using Gotenberg
 */
async function convertHtmlToPdf(htmlContent) {
  const formData = new FormData();
  formData.append('files', Buffer.from(htmlContent, 'utf-8'), {
    filename: 'index.html',
    contentType: 'text/html'
  });

  // Add margin settings for better PDF output
  formData.append('marginTop', '0.5');
  formData.append('marginBottom', '0.5');
  formData.append('marginLeft', '0.5');
  formData.append('marginRight', '0.5');

  const response = await fetch('http://matterconvert:3000/forms/chromium/convert/html', {
    method: 'POST',
    body: formData,
    headers: formData.getHeaders()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gotenberg returned ${response.status}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Format date for display
 */
function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Sanitize filename for safe download
 */
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100) || 'conversation';
}

module.exports = router;
