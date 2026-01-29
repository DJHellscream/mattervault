/**
 * Audit logging routes
 * Admin-only endpoints for exporting and summarizing audit logs
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
 * GET /api/audit/recent
 * Get recent audit logs with pagination for the admin UI
 * Query params: limit (default 50, max 200), offset (default 0), family_id, username
 * Admin only
 */
router.get('/recent', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { family_id, username, start_date, end_date } = req.query;

    // Build query with optional filters
    let query = `
      SELECT
        id,
        correlation_id,
        paperless_username,
        family_id,
        query_text,
        response_text,
        total_latency_ms,
        created_at
      FROM audit.chat_query_logs
      WHERE 1=1
    `;
    let countQuery = `SELECT COUNT(*) as total FROM audit.chat_query_logs WHERE 1=1`;
    const params = [];
    const countParams = [];
    let paramIndex = 1;

    if (family_id) {
      query += ` AND family_id = $${paramIndex}`;
      countQuery += ` AND family_id = $${paramIndex}`;
      params.push(family_id);
      countParams.push(family_id);
      paramIndex++;
    }

    if (username) {
      query += ` AND paperless_username ILIKE $${paramIndex}`;
      countQuery += ` AND paperless_username ILIKE $${paramIndex}`;
      params.push(`%${username}%`);
      countParams.push(`%${username}%`);
      paramIndex++;
    }

    if (start_date) {
      query += ` AND created_at >= $${paramIndex}`;
      countQuery += ` AND created_at >= $${paramIndex}`;
      params.push(new Date(start_date).toISOString());
      countParams.push(new Date(start_date).toISOString());
      paramIndex++;
    }

    if (end_date) {
      query += ` AND created_at < $${paramIndex}`;
      countQuery += ` AND created_at < $${paramIndex}`;
      params.push(new Date(end_date).toISOString());
      countParams.push(new Date(end_date).toISOString());
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    // Execute both queries
    const [logsResult, countResult] = await Promise.all([
      db.query(query, params),
      db.query(countQuery, countParams)
    ]);

    res.json({
      logs: logsResult.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit,
        offset,
        has_more: offset + logsResult.rows.length < parseInt(countResult.rows[0].total)
      }
    });

  } catch (err) {
    console.error('Recent logs error:', err);
    res.status(500).json({
      error: 'Failed to fetch recent logs',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * GET /api/audit/export
 * Stream audit logs as JSONL for a date range
 * Query params: start_date, end_date (ISO 8601 format)
 * Admin only
 */
router.get('/export', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date, family_id, user_id } = req.query;

    // Validate date range
    if (!start_date || !end_date) {
      return res.status(400).json({
        error: 'start_date and end_date are required (ISO 8601 format)',
        code: 'VALIDATION_ERROR'
      });
    }

    const startDate = new Date(start_date);
    const endDate = new Date(end_date);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format. Use ISO 8601 (e.g., 2026-01-01)',
        code: 'VALIDATION_ERROR'
      });
    }

    // Limit date range to 1 year max to prevent huge exports
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    if (endDate - startDate > oneYear) {
      return res.status(400).json({
        error: 'Date range cannot exceed 1 year',
        code: 'VALIDATION_ERROR'
      });
    }

    // Build query with optional filters
    let query = `
      SELECT
        id,
        correlation_id,
        n8n_execution_id,
        user_id,
        paperless_username,
        client_ip,
        user_agent,
        family_id,
        conversation_id,
        query_text,
        response_text,
        documents_retrieved,
        documents_cited,
        total_latency_ms,
        created_at
      FROM audit.chat_query_logs
      WHERE created_at >= $1 AND created_at < $2
    `;
    const params = [startDate.toISOString(), endDate.toISOString()];
    let paramIndex = 3;

    if (family_id) {
      query += ` AND family_id = $${paramIndex}`;
      params.push(family_id);
      paramIndex++;
    }

    if (user_id) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(user_id);
      paramIndex++;
    }

    query += ' ORDER BY created_at ASC';

    // Set headers for JSONL streaming
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="audit-export-${start_date}-to-${end_date}.jsonl"`);
    res.setHeader('X-Accel-Buffering', 'no');

    // Execute query and stream results
    const { rows } = await db.query(query, params);

    for (const row of rows) {
      res.write(JSON.stringify(row) + '\n');
    }

    res.end();

  } catch (err) {
    console.error('Export error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Export failed',
        code: 'SERVER_ERROR'
      });
    }
  }
});

/**
 * GET /api/audit/summary
 * Get aggregate statistics by user, family, or month
 * Query params:
 *   - group_by: 'user' | 'family' | 'month' (default: 'month')
 *   - start_date, end_date (optional, defaults to last 30 days)
 * Admin only
 */
router.get('/summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { group_by = 'month', start_date, end_date } = req.query;

    // Default to last 30 days if no date range specified
    const endDate = end_date ? new Date(end_date) : new Date();
    const startDate = start_date ? new Date(start_date) : new Date(endDate - 30 * 24 * 60 * 60 * 1000);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format. Use ISO 8601 (e.g., 2026-01-01)',
        code: 'VALIDATION_ERROR'
      });
    }

    let query;
    const params = [startDate.toISOString(), endDate.toISOString()];

    switch (group_by) {
      case 'user':
        query = `
          SELECT
            paperless_username,
            user_id,
            COUNT(*) as query_count,
            AVG(total_latency_ms)::INTEGER as avg_latency_ms,
            MIN(created_at) as first_query,
            MAX(created_at) as last_query
          FROM audit.chat_query_logs
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY paperless_username, user_id
          ORDER BY query_count DESC
        `;
        break;

      case 'family':
        query = `
          SELECT
            family_id,
            COUNT(*) as query_count,
            COUNT(DISTINCT user_id) as unique_users,
            AVG(total_latency_ms)::INTEGER as avg_latency_ms,
            MIN(created_at) as first_query,
            MAX(created_at) as last_query
          FROM audit.chat_query_logs
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY family_id
          ORDER BY query_count DESC
        `;
        break;

      case 'month':
      default:
        query = `
          SELECT
            DATE_TRUNC('month', created_at) as month,
            COUNT(*) as query_count,
            COUNT(DISTINCT user_id) as unique_users,
            COUNT(DISTINCT family_id) as unique_families,
            AVG(total_latency_ms)::INTEGER as avg_latency_ms
          FROM audit.chat_query_logs
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY DATE_TRUNC('month', created_at)
          ORDER BY month DESC
        `;
        break;
    }

    const { rows } = await db.query(query, params);

    res.json({
      summary: {
        group_by,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        total_groups: rows.length
      },
      data: rows
    });

  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({
      error: 'Failed to generate summary',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * GET /api/audit/query/:correlationId
 * Get a single audit log by correlation ID
 * Admin only
 */
router.get('/query/:correlationId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { correlationId } = req.params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(correlationId)) {
      return res.status(400).json({
        error: 'Invalid correlation ID format',
        code: 'VALIDATION_ERROR'
      });
    }

    const { rows } = await db.query(
      `SELECT * FROM audit.chat_query_logs WHERE correlation_id = $1`,
      [correlationId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Audit log not found',
        code: 'NOT_FOUND'
      });
    }

    res.json({ audit_log: rows[0] });

  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({
      error: 'Failed to fetch audit log',
      code: 'SERVER_ERROR'
    });
  }
});

module.exports = router;
