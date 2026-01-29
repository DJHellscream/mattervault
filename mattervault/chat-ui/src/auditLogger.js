/**
 * Audit Logger Module
 * Provides immutable audit logging for chat queries
 * 7-year retention with local archive support
 */

const { randomUUID } = require('crypto');
const db = require('./db');

/**
 * Generate a unique correlation ID for tracking requests
 * @returns {string} UUID v4 correlation ID
 */
function generateCorrelationId() {
  return randomUUID();
}

/**
 * Log a chat query to the audit table
 * @param {Object} params - Audit log parameters
 * @param {string} params.correlationId - UUID linking request through the system
 * @param {string} [params.n8nExecutionId] - N8N execution ID for debugging
 * @param {string} params.userId - User's internal ID
 * @param {string} [params.paperlessUsername] - Paperless username
 * @param {string} [params.clientIp] - Client IP address
 * @param {string} [params.userAgent] - Client user agent
 * @param {string} params.familyId - Family/tenant ID
 * @param {string} [params.conversationId] - Conversation context ID
 * @param {string} params.queryText - The user's question
 * @param {string} [params.responseText] - The LLM's answer
 * @param {Array} [params.documentsRetrieved] - All docs returned from search
 * @param {Array} [params.documentsCited] - Docs cited in the response
 * @param {number} [params.totalLatencyMs] - End-to-end request time in ms
 * @returns {Promise<string>} The created audit log ID
 */
async function logQuery(params) {
  const {
    correlationId,
    n8nExecutionId,
    userId,
    paperlessUsername,
    clientIp,
    userAgent,
    familyId,
    conversationId,
    queryText,
    responseText,
    documentsRetrieved,
    documentsCited,
    totalLatencyMs
  } = params;

  // Validate required fields
  if (!correlationId) {
    throw new Error('correlationId is required for audit logging');
  }
  if (!userId) {
    throw new Error('userId is required for audit logging');
  }
  if (!familyId) {
    throw new Error('familyId is required for audit logging');
  }
  if (!queryText) {
    throw new Error('queryText is required for audit logging');
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO audit.chat_query_logs (
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
        total_latency_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        correlationId,
        n8nExecutionId || null,
        userId,
        paperlessUsername || null,
        clientIp || null,
        userAgent || null,
        familyId,
        conversationId || null,
        queryText,
        responseText || null,
        documentsRetrieved ? JSON.stringify(documentsRetrieved) : null,
        documentsCited ? JSON.stringify(documentsCited) : null,
        totalLatencyMs || null
      ]
    );

    return rows[0].id;
  } catch (err) {
    // Log error but don't throw - audit logging should not break chat functionality
    console.error('Audit logging failed:', err.message);
    console.error('Audit data:', {
      correlationId,
      userId,
      familyId,
      queryText: queryText?.substring(0, 50) + '...'
    });
    return null;
  }
}

/**
 * Extract client IP from request, handling proxies
 * @param {Object} req - Express request object
 * @returns {string|null} Client IP address
 */
function getClientIp(req) {
  // Check X-Forwarded-For header (set by proxies/load balancers)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // Take the first IP in the chain (original client)
    return forwarded.split(',')[0].trim();
  }

  // Check X-Real-IP header (nginx)
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return realIp;
  }

  // Fall back to direct connection IP
  return req.ip || req.connection?.remoteAddress || null;
}

/**
 * Extract user agent from request
 * @param {Object} req - Express request object
 * @returns {string|null} User agent string
 */
function getUserAgent(req) {
  return req.headers['user-agent'] || null;
}

module.exports = {
  generateCorrelationId,
  logQuery,
  getClientIp,
  getUserAgent
};
