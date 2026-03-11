const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createApiRouter } = require('./api');
const { createStreamingRouter } = require('./streaming');
const authRoutes = require('./routes/auth');
const auditRoutes = require('./routes/audit');
const conversationsRoutes = require('./routes/conversations');
const { createDocumentsRouter } = require('./routes/documents');
const { waitForDatabase, runMigrations } = require('./migrations');
const { requireAuth } = require('./middleware/auth');

// Process-level error handlers — prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit — log and continue serving
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Give time for logs to flush, then exit (Docker will restart)
  setTimeout(() => process.exit(1), 1000);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from environment
const config = {
  paperless: {
    url: process.env.PAPERLESS_URL || 'http://mattervault:8000',
    user: process.env.PAPERLESS_USER || 'admin',
    pass: process.env.PAPERLESS_PASS || 'mattervault2025'
  },
  qdrant: {
    url: process.env.QDRANT_URL || 'http://mattermemory:6333'
  },
  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL || 'http://matterlogic:5678/webhook/chat-api'
  }
};

// Middleware
app.use(express.json());
app.use(cookieParser());

// Serve static files (login.html, register.html accessible without auth)
app.use(express.static(path.join(__dirname, '../public')));

// Auth routes (no auth required for login/register)
app.use('/api/auth', authRoutes);

// Protected conversations routes
app.use('/api/conversations', requireAuth, conversationsRoutes);

// Protected documents routes (for PDF preview with family authorization)
app.use('/api/documents', requireAuth, createDocumentsRouter(config));

// Protected audit routes (admin only - enforced in route handlers)
app.use('/api/audit', auditRoutes);

// Protected streaming routes (SSE for chat)
app.use('/api/chat', requireAuth, createStreamingRouter(config));

// Protected API routes
app.use('/api', requireAuth, createApiRouter(config));

// Serve login page
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Serve audit admin page (auth check happens client-side)
app.get('/audit', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/audit.html'));
});

// Registration is disabled - users authenticate via Paperless
// Redirect old register links to login
app.get('/register.html', (req, res) => {
  res.redirect('/login.html');
});

// Serve index (main app) - client-side will handle auth check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Enhanced health check endpoint (public)
app.get('/health', async (req, res) => {
  const db = require('./db');
  const { redis } = require('./auth');

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      database: false,
      redis: false
    },
    metrics: {
      conversation_count: 0,
      message_count: 0,
      active_sessions: 0,
      last_query_at: null
    }
  };

  // Check database connection
  try {
    const dbHealthy = await db.healthCheck();
    health.services.database = dbHealthy;

    if (dbHealthy) {
      // Get conversation count
      const convResult = await db.query('SELECT COUNT(*) as count FROM conversations');
      health.metrics.conversation_count = parseInt(convResult.rows[0].count);

      // Get message count
      const msgResult = await db.query('SELECT COUNT(*) as count FROM messages');
      health.metrics.message_count = parseInt(msgResult.rows[0].count);

      // Get active sessions count (non-expired)
      const sessionResult = await db.query(
        'SELECT COUNT(*) as count FROM sessions WHERE expires_at > NOW()'
      );
      health.metrics.active_sessions = parseInt(sessionResult.rows[0].count);

      // Get last chat query timestamp from audit logs
      try {
        const auditResult = await db.query(
          'SELECT created_at FROM audit.chat_query_logs ORDER BY created_at DESC LIMIT 1'
        );
        if (auditResult.rows.length > 0) {
          health.metrics.last_query_at = auditResult.rows[0].created_at;
        }
      } catch (auditErr) {
        // Audit table might not exist yet
        health.metrics.last_query_at = null;
      }
    }
  } catch (err) {
    health.services.database = false;
    console.error('Health check DB error:', err.message);
  }

  // Check Redis connection
  try {
    const pingResult = await redis.ping();
    health.services.redis = pingResult === 'PONG';
  } catch (err) {
    health.services.redis = false;
    console.error('Health check Redis error:', err.message);
  }

  // Overall status
  health.status = (health.services.database && health.services.redis) ? 'ok' : 'degraded';

  const httpStatus = health.status === 'ok' ? 200 : 503;
  res.status(httpStatus).json(health);
});

// Start server with database initialization
async function start() {
  try {
    // Wait for database to be ready
    await waitForDatabase();

    // Run migrations
    await runMigrations();

    // Start Express server
    app.listen(PORT, () => {
      console.log(`Mattervault Chat UI running on port ${PORT}`);
      console.log(`Paperless: ${config.paperless.url}`);
      console.log(`Qdrant: ${config.qdrant.url}`);
      console.log(`n8n Webhook: ${config.n8n.webhookUrl}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app };
