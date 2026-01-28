/**
 * Documents routes
 * Document preview with family-based access control
 */

const express = require('express');

const router = express.Router();

// Store config reference for use in routes
let paperlessConfig = null;

/**
 * Initialize router with config
 * @param {Object} config - Application config with paperless credentials
 */
function createDocumentsRouter(config) {
  paperlessConfig = config.paperless;

  /**
   * GET /api/documents/:id/preview
   * Stream PDF from Paperless with family tag authorization
   *
   * Security:
   * - Requires authentication (via requireAuth middleware)
   * - Validates document has user's family tag
   * - Only allows access to documents tagged with user's family_id
   */
  router.get('/:id/preview', async (req, res) => {
    try {
      const docId = req.params.id;
      const userFamilyId = req.user.familyId;

      // Validate docId is a number
      if (!/^\d+$/.test(docId)) {
        return res.status(400).json({
          error: 'Invalid document ID',
          code: 'INVALID_ID'
        });
      }

      // Create Basic auth header for Paperless API
      const authHeader = 'Basic ' + Buffer.from(
        `${paperlessConfig.user}:${paperlessConfig.pass}`
      ).toString('base64');

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
        throw new Error(`Paperless API error: ${metadataResponse.status}`);
      }

      const docMetadata = await metadataResponse.json();

      // 2. Fetch tag details to check family authorization
      // Document metadata includes tag IDs, we need to fetch tag slugs
      const tagIds = docMetadata.tags || [];

      if (tagIds.length === 0) {
        // Document has no tags, cannot verify family access
        return res.status(403).json({
          error: 'Access denied: document has no family tag',
          code: 'FORBIDDEN'
        });
      }

      // Fetch tag details to get slugs
      const tagsResponse = await fetch(
        `${paperlessConfig.url}/api/tags/?id__in=${tagIds.join(',')}`,
        {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json'
          }
        }
      );

      if (!tagsResponse.ok) {
        throw new Error(`Failed to fetch tags: ${tagsResponse.status}`);
      }

      const tagsData = await tagsResponse.json();
      const tags = tagsData.results || [];

      // 3. Check if document has user's family tag
      const hasAccess = tags.some(tag =>
        tag.slug === userFamilyId ||
        tag.name.toLowerCase() === userFamilyId.toLowerCase()
      );

      if (!hasAccess) {
        console.log(`Access denied for user family '${userFamilyId}' to document ${docId}. Tags: ${tags.map(t => t.slug).join(', ')}`);
        return res.status(403).json({
          error: 'Access denied: document belongs to a different family',
          code: 'FORBIDDEN'
        });
      }

      // 4. Stream PDF from Paperless to response
      const downloadResponse = await fetch(
        `${paperlessConfig.url}/api/documents/${docId}/download/`,
        {
          headers: {
            'Authorization': authHeader
          }
        }
      );

      if (!downloadResponse.ok) {
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
   * Also requires family authorization
   */
  router.get('/:id/metadata', async (req, res) => {
    try {
      const docId = req.params.id;
      const userFamilyId = req.user.familyId;

      // Validate docId is a number
      if (!/^\d+$/.test(docId)) {
        return res.status(400).json({
          error: 'Invalid document ID',
          code: 'INVALID_ID'
        });
      }

      const authHeader = 'Basic ' + Buffer.from(
        `${paperlessConfig.user}:${paperlessConfig.pass}`
      ).toString('base64');

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
        throw new Error(`Paperless API error: ${metadataResponse.status}`);
      }

      const docMetadata = await metadataResponse.json();
      const tagIds = docMetadata.tags || [];

      // Fetch and validate tags
      if (tagIds.length > 0) {
        const tagsResponse = await fetch(
          `${paperlessConfig.url}/api/tags/?id__in=${tagIds.join(',')}`,
          {
            headers: {
              'Authorization': authHeader,
              'Accept': 'application/json'
            }
          }
        );

        if (tagsResponse.ok) {
          const tagsData = await tagsResponse.json();
          const tags = tagsData.results || [];

          const hasAccess = tags.some(tag =>
            tag.slug === userFamilyId ||
            tag.name.toLowerCase() === userFamilyId.toLowerCase()
          );

          if (!hasAccess) {
            return res.status(403).json({
              error: 'Access denied: document belongs to a different family',
              code: 'FORBIDDEN'
            });
          }
        }
      } else {
        return res.status(403).json({
          error: 'Access denied: document has no family tag',
          code: 'FORBIDDEN'
        });
      }

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
