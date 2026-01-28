const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createApiRouter } = require('./api');
const authRoutes = require('./routes/auth');
const { waitForDatabase, runMigrations } = require('./migrations');
const { requireAuth } = require('./middleware/auth');

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
    webhookUrl: process.env.N8N_WEBHOOK_URL || 'http://matterlogic:5678/webhook/chat-api-v3'
  }
};

// Middleware
app.use(express.json());
app.use(cookieParser());

// Serve static files (login.html, register.html accessible without auth)
app.use(express.static(path.join(__dirname, '../public')));

// Auth routes (no auth required for login/register)
app.use('/api/auth', authRoutes);

// Protected API routes
app.use('/api', requireAuth, createApiRouter(config));

// Serve login page
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// Serve register page
app.get('/register.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/register.html'));
});

// Serve index (main app) - client-side will handle auth check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

start();

module.exports = { app };
