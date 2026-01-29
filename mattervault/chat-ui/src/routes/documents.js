/**
 * Documents routes
 * Document preview using user's Paperless token (open access model)
 */

const express = require('express');
const auth = require('../auth');

const router = express.Router();

// Store config reference for use in routes
let paperlessConfig = null;

/**
 * Initialize router with config
 * @param {Object} config - Application config with paperless URL
 */
function createDocumentsRouter(config) {
  paperlessConfig = config.paperless;

  /**
   * GET /api/documents/:id/preview
   * Stream PDF from Paperless using user's Paperless token
   *
   * Security:
   * - Requires authentication (via requireAuth middleware)
   * - Uses user's Paperless token (Paperless enforces its own permissions)
   * - Open access model: no family_id validation at this layer
   */
  router.get('/:id/preview', async (req, res) => {
    try {
      const docId = req.params.id;

      // Validate docId is a number
      if (!/^\d+$/.test(docId)) {
        return res.status(400).json({
          error: 'Invalid document ID',
          code: 'INVALID_ID'
        });
      }

      // Get user's Paperless token from database
      const user = await auth.getUserById(req.user.id);
      if (!user || !user.paperless_token) {
        return res.status(401).json({
          error: 'Paperless authentication required. Please log in again.',
          code: 'NO_PAPERLESS_TOKEN'
        });
      }

      const authHeader = `Token ${user.paperless_token}`;

      // 1. Fetch document metadata from Paperless API
      const metadataResponse = await fetch(
        `${paperlessConfig.url}/api/documents/${docId}/`,
        {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
          }
        }
      );

      if (!metadataResponse.ok) {
        if (metadataResponse.status === 404) {
          return res.status(404).json({
            error: 'Document not found',
            code: 'NOT_FOUND'
          });
        }
        if (metadataResponse.status === 403) {
          return res.status(403).json({
            error: 'Access denied by Paperless',
            code: 'FORBIDDEN'
          });
        }
        throw new Error(`Paperless API error: ${metadataResponse.status}`);
      }

      const docMetadata = await metadataResponse.json();

      // 2. Stream PDF from Paperless to response
      const downloadResponse = await fetch(
        `${paperlessConfig.url}/api/documents/${docId}/download/`,
        {
          headers: {
            'Authorization': authHeader
          }
        }
      );

      if (!downloadResponse.ok) {
        if (downloadResponse.status === 403) {
          return res.status(403).json({
            error: 'Access denied by Paperless',
            code: 'FORBIDDEN'
          });
        }
        throw new Error(`Failed to download document: ${downloadResponse.status}`);
      }

      // Set response headers for PDF
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${docMetadata.title || 'document'}.pdf"`);

      // Stream the PDF response
      const reader = downloadResponse.body.getReader();

      async function streamResponse() {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      }

      await streamResponse();

    } catch (err) {
      console.error('Error previewing document:', err);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to preview document',
          code: 'SERVER_ERROR',
          details: err.message
        });
      }
    }
  });

  /**
   * GET /api/documents/:id/metadata
   * Get document metadata (title, tags, etc.) for display purposes
   * Uses user's Paperless token (Paperless enforces its own permissions)
   */
  router.get('/:id/metadata', async (req, res) => {
    try {
      const docId = req.params.id;

      // Validate docId is a number
      if (!/^\d+$/.test(docId)) {
        return res.status(400).json({
          error: 'Invalid document ID',
          code: 'INVALID_ID'
        });
      }

      // Get user's Paperless token from database
      const user = await auth.getUserById(req.user.id);
      if (!user || !user.paperless_token) {
        return res.status(401).json({
          error: 'Paperless authentication required. Please log in again.',
          code: 'NO_PAPERLESS_TOKEN'
        });
      }

      const authHeader = `Token ${user.paperless_token}`;

      // Fetch document metadata
      const metadataResponse = await fetch(
        `${paperlessConfig.url}/api/documents/${docId}/`,
        {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
          }
        }
      );

      if (!metadataResponse.ok) {
        if (metadataResponse.status === 404) {
          return res.status(404).json({
            error: 'Document not found',
            code: 'NOT_FOUND'
          });
        }
        if (metadataResponse.status === 403) {
          return res.status(403).json({
            error: 'Access denied by Paperless',
            code: 'FORBIDDEN'
          });
        }
        throw new Error(`Paperless API error: ${metadataResponse.status}`);
      }

      const docMetadata = await metadataResponse.json();

      // Return sanitized metadata
      res.json({
        id: docMetadata.id,
        title: docMetadata.title,
        created: docMetadata.created,
        modified: docMetadata.modified,
        pageCount: docMetadata.page_count
      });

    } catch (err) {
      console.error('Error fetching document metadata:', err);
      res.status(500).json({
        error: 'Failed to fetch document metadata',
        code: 'SERVER_ERROR'
      });
    }
  });

  return router;
}

module.exports = { createDocumentsRouter };
