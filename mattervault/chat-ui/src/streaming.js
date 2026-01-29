/**
 * Chat module - Thin presentation layer
 * All business logic (persistence, RAG, audit) handled by n8n
 */

const express = require('express');
const { randomUUID } = require('crypto');

// Professional loading phrases a paralegal might say
const LOADING_PHRASES = [
  'Reviewing the case files...',
  'Checking the documentation...',
  'Searching through the records...',
  'Consulting the archives...',
  'Examining the relevant documents...',
  'Looking through the files...',
  'Reviewing the matter history...',
  'Checking our records...',
  'Pulling up the relevant information...',
  'Searching the document repository...'
];

/**
 * Get a random loading phrase
 */
function getLoadingPhrase() {
  return LOADING_PHRASES[Math.floor(Math.random() * LOADING_PHRASES.length)];
}

/**
 * Extract client IP from request, handling proxies
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp;
  return req.ip || req.connection?.remoteAddress || null;
}

/**
 * Create the chat router
 * @param {Object} config - Configuration object with n8n webhook URL
 * @returns {express.Router}
 */
function createStreamingRouter(config) {
  const router = express.Router();

  /**
   * POST /api/chat
   * Send a chat message and get a response
   * Body: { question, family_id, conversation_id? }
   */
  router.post('/', async (req, res) => {
    const startTime = Date.now();
    const correlationId = randomUUID();

    try {
      const userId = req.user.id;
      const paperlessUsername = req.user.paperlessUsername || req.user.username;
      const { question, family_id, conversation_id } = req.body;

      // Validate required parameters
      if (!question) {
        return res.status(400).json({ error: 'question is required' });
      }
      if (!family_id) {
        return res.status(400).json({ error: 'family_id is required' });
      }

      // Call n8n - it handles everything: conversation, messages, RAG, audit
      const n8nResponse = await fetch(config.n8n.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          family_id,
          conversation_id: conversation_id || null,
          user_id: userId,
          paperless_username: paperlessUsername,
          correlation_id: correlationId,
          client_ip: getClientIp(req),
          user_agent: req.headers['user-agent'] || null
        })
      });

      if (!n8nResponse.ok) {
        const errorText = await n8nResponse.text();
        console.error(`n8n error: ${n8nResponse.status} - ${errorText}`);
        return res.status(502).json({
          error: 'Failed to process request',
          details: n8nResponse.status === 500 ? 'Internal processing error' : errorText
        });
      }

      const result = await n8nResponse.json();

      // Return the response
      res.json({
        output: result.output,
        conversation_id: result.conversation_id,
        is_new_conversation: result.is_new_conversation,
        citations: result.citations || [],
        correlation_id: result.correlation_id,
        latency_ms: Date.now() - startTime
      });

    } catch (err) {
      console.error('Chat error:', err);
      res.status(500).json({
        error: 'An error occurred processing your request',
        correlation_id: correlationId
      });
    }
  });

  /**
   * GET /api/chat/stream
   * SSE endpoint for loading status updates
   * Query params: question, family_id, conversation_id?
   *
   * This provides a nice UX with status updates while n8n processes
   */
  router.get('/stream', async (req, res) => {
    const startTime = Date.now();
    const correlationId = randomUUID();

    const userId = req.user.id;
    const paperlessUsername = req.user.paperlessUsername || req.user.username;
    const { question, family_id, conversation_id } = req.query;

    // Validate required parameters
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }
    if (!family_id) {
      return res.status(400).json({ error: 'family_id is required' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Track if client disconnected
    let clientDisconnected = false;
    req.on('close', () => {
      clientDisconnected = true;
    });

    // Send initial status
    res.write(`data: ${JSON.stringify({ type: 'status', status: getLoadingPhrase() })}\n\n`);

    // Rotate loading phrases while waiting
    const phraseInterval = setInterval(() => {
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ type: 'status', status: getLoadingPhrase() })}\n\n`);
      }
    }, 3000);

    try {
      // Call n8n - it handles everything
      const n8nResponse = await fetch(config.n8n.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          family_id,
          conversation_id: conversation_id || null,
          user_id: userId,
          paperless_username: paperlessUsername,
          correlation_id: correlationId,
          client_ip: getClientIp(req),
          user_agent: req.headers['user-agent'] || null
        })
      });

      clearInterval(phraseInterval);

      if (clientDisconnected) {
        return;
      }

      if (!n8nResponse.ok) {
        const errorText = await n8nResponse.text();
        console.error(`n8n error: ${n8nResponse.status} - ${errorText}`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to process request' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const result = await n8nResponse.json();

      // Send conversation_id if this was a new conversation
      if (result.is_new_conversation) {
        res.write(`data: ${JSON.stringify({
          type: 'conversation_id',
          conversation_id: result.conversation_id
        })}\n\n`);
      }

      // Send the complete response
      res.write(`data: ${JSON.stringify({
        type: 'complete',
        output: result.output,
        conversation_id: result.conversation_id,
        citations: result.citations || [],
        correlation_id: result.correlation_id,
        latency_ms: Date.now() - startTime
      })}\n\n`);

      res.write('data: [DONE]\n\n');
      res.end();

    } catch (err) {
      clearInterval(phraseInterval);

      if (clientDisconnected) {
        console.log('Request aborted due to client disconnect');
        return;
      }

      console.error('Chat stream error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  /**
   * GET /api/chat/conversations
   * List user's conversations
   */
  router.get('/conversations', async (req, res) => {
    // This still reads from DB directly since it's a simple query
    // Could move to n8n later if needed
    const db = require('./db');
    try {
      const { rows } = await db.query(
        `SELECT id, family_id, title, created_at, updated_at
         FROM conversations
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT 50`,
        [req.user.id]
      );
      res.json({ conversations: rows });
    } catch (err) {
      console.error('List conversations error:', err);
      res.status(500).json({ error: 'Failed to list conversations' });
    }
  });

  /**
   * GET /api/chat/conversations/:id/messages
   * Get messages for a conversation
   */
  router.get('/conversations/:id/messages', async (req, res) => {
    const db = require('./db');
    try {
      // Verify user owns conversation
      const { rows: convRows } = await db.query(
        `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );

      if (convRows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const { rows } = await db.query(
        `SELECT id, role, content, citations, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC`,
        [req.params.id]
      );

      res.json({ messages: rows });
    } catch (err) {
      console.error('Get messages error:', err);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });

  return router;
}

module.exports = { createStreamingRouter };
