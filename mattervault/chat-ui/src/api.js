const express = require('express');
const db = require('./db');

// System tags to filter out from family list
const SYSTEM_TAGS = ['inbox', 'intake', 'processed', 'error', 'pending'];

function createApiRouter(config) {
  const router = express.Router();

  /**
   * GET /api/families
   * Returns list of family tags with document counts from both Paperless and Qdrant
   */
  router.get('/families', async (req, res) => {
    try {
      // 1. Fetch tags from Paperless API
      const authHeader = 'Basic ' + Buffer.from(`${config.paperless.user}:${config.paperless.pass}`).toString('base64');

      const tagsResponse = await fetch(`${config.paperless.url}/api/tags/`, {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json'
        }
      });

      if (!tagsResponse.ok) {
        throw new Error(`Paperless API error: ${tagsResponse.status}`);
      }

      const tagsData = await tagsResponse.json();
      const tags = tagsData.results || [];

      // 2. Filter out system tags
      const familyTags = tags.filter(tag =>
        !SYSTEM_TAGS.includes(tag.name.toLowerCase()) &&
        !SYSTEM_TAGS.includes(tag.slug.toLowerCase())
      );

      // 3. For each family tag, query Qdrant for document count
      const families = await Promise.all(familyTags.map(async (tag) => {
        let indexedDocs = 0;

        try {
          const qdrantResponse = await fetch(`${config.qdrant.url}/collections/mattervault_documents_v2/points/count`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filter: {
                must: [{ key: 'family_id', match: { value: tag.slug } }]
              }
            })
          });

          if (qdrantResponse.ok) {
            const qdrantData = await qdrantResponse.json();
            indexedDocs = qdrantData.result?.count || 0;
          }
        } catch (err) {
          console.error(`Qdrant count error for ${tag.slug}:`, err.message);
        }

        return {
          id: tag.id,
          name: tag.name,
          slug: tag.slug,
          paperless_docs: tag.document_count || 0,
          indexed_docs: indexedDocs
        };
      }));

      res.json(families);
    } catch (err) {
      console.error('Error fetching families:', err);
      res.status(500).json({ error: 'Failed to fetch families', details: err.message });
    }
  });

  /**
   * POST /api/chat
   * Forwards chat request to n8n webhook with conversation persistence
   * Body: { family_id, question, session_id, conversation_id? }
   */
  router.post('/chat', async (req, res) => {
    try {
      const userId = req.user.id;
      const { family_id, question, session_id, conversation_id } = req.body;

      if (!family_id) {
        return res.status(400).json({ error: 'family_id is required' });
      }

      if (!question) {
        return res.status(400).json({ error: 'question is required' });
      }

      let conversationId = conversation_id;

      // If no conversation_id, create a new conversation
      if (!conversationId) {
        // Auto-generate title from first message
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
      } else {
        // Verify user owns this conversation
        const { rows } = await db.query(
          `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
          [conversationId, userId]
        );

        if (rows.length === 0) {
          return res.status(404).json({
            error: 'Conversation not found',
            code: 'NOT_FOUND'
          });
        }
      }

      // Save user message
      await db.query(
        `INSERT INTO messages (conversation_id, role, content)
         VALUES ($1, $2, $3)`,
        [conversationId, 'user', question]
      );

      // Forward to n8n webhook
      const n8nResponse = await fetch(config.n8n.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id,
          question,
          session_id: session_id || `chat-ui-${Date.now()}`
        })
      });

      if (!n8nResponse.ok) {
        const errorText = await n8nResponse.text();
        throw new Error(`n8n webhook error: ${n8nResponse.status} - ${errorText}`);
      }

      const responseData = await n8nResponse.json();

      // Extract answer and citations from n8n response
      const answer = responseData.text || responseData.output || responseData.answer || responseData.response || JSON.stringify(responseData);

      // Try to extract citations if available in response
      let citations = null;
      if (responseData.citations) {
        citations = responseData.citations;
      } else if (responseData.sources) {
        citations = responseData.sources;
      }

      // Save assistant message
      await db.query(
        `INSERT INTO messages (conversation_id, role, content, citations)
         VALUES ($1, $2, $3, $4)`,
        [conversationId, 'assistant', answer, citations ? JSON.stringify(citations) : null]
      );

      // Update conversation's updated_at timestamp
      await db.query(
        `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
        [conversationId]
      );

      // Return response with conversation_id
      res.json({
        ...responseData,
        conversation_id: conversationId
      });
    } catch (err) {
      console.error('Error in chat:', err);
      res.status(500).json({ error: 'Chat request failed', details: err.message });
    }
  });

  /**
   * GET /api/health
   * Simple health check endpoint
   */
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}

module.exports = { createApiRouter };
