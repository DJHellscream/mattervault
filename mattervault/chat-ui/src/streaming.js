/**
 * Streaming module for SSE-based chat responses
 * Provides real-time token streaming from Ollama LLM
 */

const express = require('express');
const db = require('./db');
const AuditLogger = require('./auditLogger');

// Ollama configuration
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// Chat history configuration (sliding window)
// Number of previous messages to include for conversation context
const CHAT_HISTORY_LIMIT = parseInt(process.env.CHAT_HISTORY_LIMIT) || 10;

/**
 * System prompt for Mattervault legal assistant
 */
const SYSTEM_PROMPT = `You are Mattervault, an expert legal analyst and estate planning assistant.

IMPORTANT INSTRUCTIONS:
- Answer ONLY based on the provided Context documents below.
- If the answer is not in the context, state clearly that you do not have enough information to answer.
- Do NOT hallucinate or make up information not present in the context.
- Always cite the Source Document and Page Number for every claim (e.g., "Source: Document_Name.pdf, Page 4").
- Be precise, professional, and helpful.
- Format your responses clearly with proper paragraphs.`;

/**
 * Create the streaming router
 * @param {Object} config - Configuration object with n8n webhook URL
 * @returns {express.Router}
 */
function createStreamingRouter(config) {
  const router = express.Router();

  /**
   * GET /api/chat/stream
   * SSE endpoint that streams Ollama response
   * Query params: question, family_id, conversation_id
   */
  router.get('/stream', async (req, res) => {
    const userId = req.user.id;
    const paperlessUsername = req.user.paperlessUsername || req.user.username;
    const { question, family_id, conversation_id } = req.query;

    // Generate correlation ID for audit trail
    const correlationId = AuditLogger.generateCorrelationId();
    const requestStartTime = Date.now();

    // Extract client metadata for audit
    const clientIp = AuditLogger.getClientIp(req);
    const userAgent = AuditLogger.getUserAgent(req);

    // Validate required parameters
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }
    if (!family_id) {
      return res.status(400).json({ error: 'family_id is required' });
    }

    // Open access model: any authenticated user can query any family
    // Family selection is per-conversation, not restricted by user assignment

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    let conversationId = conversation_id;
    let fullResponse = '';

    // AbortController to cancel Ollama request if client disconnects
    const abortController = new AbortController();
    let clientDisconnected = false;

    req.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
      console.log('Client disconnected, aborting Ollama request');
    });

    try {
      // Step 1: Create or validate conversation
      if (!conversationId) {
        const title = question.length > 50
          ? question.substring(0, 50) + '...'
          : question;

        const { rows } = await db.query(
          `INSERT INTO conversations (user_id, family_id, title)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [userId, family_id, title]
        );
        conversationId = rows[0].id;

        // Send conversation_id to client
        res.write(`data: ${JSON.stringify({ type: 'conversation_id', conversation_id: conversationId })}\n\n`);
      } else {
        // Verify user owns this conversation
        const { rows } = await db.query(
          `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
          [conversationId, userId]
        );

        if (rows.length === 0) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'Conversation not found' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      }

      // Save user message
      await db.query(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, $2, $3)`,
        [conversationId, 'user', question]
      );

      // Fetch chat history for context (sliding window)
      // Get the last N messages BEFORE the current question (excluding it since we just added it)
      let chatHistory = [];
      if (CHAT_HISTORY_LIMIT > 0) {
        const { rows: historyRows } = await db.query(
          `SELECT role, content FROM messages
           WHERE conversation_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET 1`,  // OFFSET 1 to skip the question we just inserted
          [conversationId, CHAT_HISTORY_LIMIT]
        );
        // Reverse to get chronological order (oldest first)
        chatHistory = historyRows.reverse().map(row => ({
          role: row.role,
          content: row.content
        }));
      }

      // Step 2: Get context from n8n (search + rerank)
      res.write(`data: ${JSON.stringify({ type: 'status', status: 'searching' })}\n\n`);

      const contextResponse = await fetch(config.n8n.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id,
          question,
          chat_history: chatHistory,  // Include conversation history
          session_id: `stream-${Date.now()}`,
          context_only: true,  // Flag to request only context, not generation
          correlation_id: correlationId  // Audit trail tracking
        })
      });

      let context = '';
      let citations = [];
      let n8nFullResponse = null; // If n8n returns a full answer, use it directly
      let documentsRetrieved = []; // All docs returned by search (for audit)
      let n8nExecutionId = null; // N8N execution ID (for audit)

      if (contextResponse.ok) {
        const contextData = await contextResponse.json();

        // Extract n8n execution ID for audit trail
        n8nExecutionId = contextData.execution_id || contextData.executionId || null;

        // Extract documents retrieved for audit (before any filtering)
        if (contextData.documents_retrieved) {
          documentsRetrieved = contextData.documents_retrieved;
        } else if (contextData.documents) {
          documentsRetrieved = contextData.documents.map(doc => ({
            document_id: doc.document_id,
            title: doc.source || doc.document_title,
            page: doc.page_num || doc.page,
            score: doc.score
          }));
        }

        // Extract context from n8n response
        // The n8n workflow may return context in different formats
        if (contextData.output || contextData.text || contextData.answer || contextData.response) {
          // n8n returned a full generated answer - use it directly (skip Ollama)
          n8nFullResponse = contextData.output || contextData.text || contextData.answer || contextData.response;
          // Also extract citations if n8n included them
          if (contextData.citations && Array.isArray(contextData.citations)) {
            citations = contextData.citations.map(c => ({
              source: c.source || c.title || c.document_title,
              page: c.page || c.page_num,
              document_id: c.document_id
            }));
          }
        } else if (contextData.context) {
          context = Array.isArray(contextData.context)
            ? contextData.context.map(doc => doc.text || doc.content || doc).join('\n\n---\n\n')
            : contextData.context;
        } else if (contextData.documents) {
          context = contextData.documents.map(doc => {
            const docText = doc.text || doc.content || '';
            const source = doc.source || doc.document_title || 'Unknown';
            const page = doc.page_num || doc.page || '';
            return `[Source: ${source}${page ? `, Page ${page}` : ''}]\n${docText}`;
          }).join('\n\n---\n\n');
          citations = contextData.documents.map(doc => ({
            source: doc.source || doc.document_title,
            page: doc.page_num || doc.page,
            document_id: doc.document_id
          }));
        }
      }

      // If we couldn't get context from n8n, try a fallback or inform user
      if (!context && !n8nFullResponse) {
        context = 'No relevant documents found for this query.';
      }

      // Step 3: Generate response (use n8n response directly or call Ollama)
      res.write(`data: ${JSON.stringify({ type: 'status', status: 'generating' })}\n\n`);

      if (n8nFullResponse) {
        // n8n already generated the answer - stream it directly (simulated streaming)
        fullResponse = n8nFullResponse;

        // Send the full response as tokens (chunked for streaming effect)
        const chunkSize = 20; // characters per chunk
        for (let i = 0; i < fullResponse.length; i += chunkSize) {
          if (clientDisconnected) break;
          const chunk = fullResponse.slice(i, i + chunkSize);
          res.write(`data: ${JSON.stringify({
            type: 'token',
            content: chunk,
            done: i + chunkSize >= fullResponse.length
          })}\n\n`);
        }
      } else {
        // Call Ollama with context from n8n
        const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [
              {
                role: 'system',
                content: `${SYSTEM_PROMPT}\n\n--- CONTEXT DOCUMENTS ---\n${context}\n--- END CONTEXT ---`
              },
              { role: 'user', content: question }
            ],
            stream: true,
            options: {
              temperature: 0.3,  // Lower temperature for more factual responses
              num_predict: 2048  // Max tokens
            }
          }),
          signal: abortController.signal
        });

        if (!ollamaResponse.ok) {
          const errorText = await ollamaResponse.text();
          console.error(`Ollama error: ${ollamaResponse.status} - ${errorText}`);
          throw new Error('Failed to generate response. Please try again.');
        }

        // Ollama streams NDJSON (newline-delimited JSON)
        // Each line is a JSON object with { message: { content: "..." }, done: bool }
        const reader = ollamaResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          // Check if client disconnected before reading more
          if (clientDisconnected) break;

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const data = JSON.parse(line);
              const content = data.message?.content || '';

              if (content) {
                fullResponse += content;
                // Send token to client
                res.write(`data: ${JSON.stringify({
                  type: 'token',
                  content: content,
                  done: data.done || false
                })}\n\n`);
              }

              if (data.done) {
                // Ollama signals completion
                break;
              }
            } catch (parseErr) {
              console.error('Error parsing Ollama response line:', parseErr.message, 'Line:', line);
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer);
            const content = data.message?.content || '';
            if (content) {
              fullResponse += content;
              res.write(`data: ${JSON.stringify({
                type: 'token',
                content: content,
                done: true
              })}\n\n`);
            }
          } catch (parseErr) {
            // Ignore incomplete JSON at end
          }
        }
      }

      // Step 4: Save assistant message to database
      await db.query(
        `INSERT INTO messages (conversation_id, role, content, citations)
         VALUES ($1, $2, $3, $4)`,
        [conversationId, 'assistant', fullResponse, citations.length > 0 ? JSON.stringify(citations) : null]
      );

      // Update conversation timestamp
      await db.query(
        `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
        [conversationId]
      );

      // Step 5: Log to audit trail (async, don't block response)
      const totalLatencyMs = Date.now() - requestStartTime;
      AuditLogger.logQuery({
        correlationId,
        n8nExecutionId,
        userId,
        paperlessUsername,
        clientIp,
        userAgent,
        familyId: family_id,
        conversationId,
        queryText: question,
        responseText: fullResponse,
        documentsRetrieved,
        documentsCited: citations,
        totalLatencyMs
      }).catch(err => {
        console.error('Audit logging error (non-blocking):', err.message);
      });

      // Send completion signal
      res.write(`data: ${JSON.stringify({
        type: 'complete',
        conversation_id: conversationId,
        citations: citations
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (err) {
      // Don't send error if client already disconnected
      if (clientDisconnected || err.name === 'AbortError') {
        console.log('Request aborted due to client disconnect');
      } else {
        console.error('Streaming error:', err);

        // Send error to client
        res.write(`data: ${JSON.stringify({
          type: 'error',
          error: err.message
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }

      // If we had a partial response, still try to save it
      if (fullResponse && conversationId) {
        try {
          await db.query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, $2, $3)`,
            [conversationId, 'assistant', fullResponse + '\n\n[Response interrupted due to error]']
          );
        } catch (saveErr) {
          console.error('Failed to save partial response:', saveErr);
        }
      }
    }
  });

  /**
   * POST /api/chat/stream
   * Alternative POST endpoint for streaming (same functionality)
   * Body: { question, family_id, conversation_id }
   */
  router.post('/stream', async (req, res) => {
    // Merge body params into query so the handler can use them uniformly
    req.query = { ...req.query, ...req.body };
    // Delegate to the GET handler by re-routing
    req.method = 'GET';
    return router.handle(req, res, () => {
      res.status(404).json({ error: 'Not found' });
    });
  });

  return router;
}

module.exports = { createStreamingRouter };
