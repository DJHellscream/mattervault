/**
 * Authentication routes
 * Paperless-ngx authentication, logout, refresh, families endpoints
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 attempts per minute per IP
  message: { error: 'Too many login attempts. Please try again in a minute.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/auth/login
 * Authenticate user via Paperless-ngx credentials
 * Body: { username, password }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        error: 'Username and password are required',
        code: 'VALIDATION_ERROR'
      });
    }

    // Verify credentials against Paperless
    const tokenResponse = await auth.verifyPaperlessCredentials(username, password);
    if (!tokenResponse || !tokenResponse.token) {
      return res.status(401).json({
        error: 'Invalid username or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const paperlessToken = tokenResponse.token;

    // Get user info from Paperless
    const paperlessUser = await auth.fetchPaperlessUser(paperlessToken);
    if (!paperlessUser) {
      return res.status(401).json({
        error: 'Failed to fetch user information from Paperless',
        code: 'PAPERLESS_ERROR'
      });
    }

    // Sync user to local database
    const user = await auth.syncUserFromPaperless(paperlessUser, paperlessToken);

    // Generate tokens (rememberMe extends to 30 days)
    const accessToken = auth.generateAccessToken(user, !!rememberMe);
    const refreshToken = auth.generateRefreshToken();
    const sessionId = await auth.createSession(user.id, refreshToken);

    // Cookie expiry: 30 days if rememberMe, otherwise 24 hours
    const cookieMaxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    // Set refresh token in httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: cookieMaxAge,
      path: '/api/auth'
    });

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: cookieMaxAge,
      path: '/api/auth'
    });

    res.json({
      message: 'Login successful',
      accessToken,
      user: {
        id: user.id,
        username: user.paperless_username,
        displayName: user.display_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      error: 'Login failed',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * POST /api/auth/refresh
 * Exchange refresh token for new access token
 * Refresh token should be in httpOnly cookie
 */
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    const sessionId = req.cookies?.sessionId;

    if (!refreshToken || !sessionId) {
      return res.status(401).json({
        error: 'Refresh token required',
        code: 'NO_REFRESH_TOKEN'
      });
    }

    // Validate refresh token
    const session = await auth.validateRefreshToken(sessionId, refreshToken);
    if (!session) {
      // Clear invalid cookies
      res.clearCookie('refreshToken', { path: '/api/auth' });
      res.clearCookie('sessionId', { path: '/api/auth' });

      return res.status(401).json({
        error: 'Invalid or expired refresh token',
        code: 'INVALID_REFRESH_TOKEN'
      });
    }

    // Get user
    const user = await auth.getUserById(session.userId);
    if (!user) {
      return res.status(401).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Generate new access token
    const accessToken = auth.generateAccessToken(user);

    res.json({
      accessToken,
      user: {
        id: user.id,
        username: user.paperless_username,
        displayName: user.display_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({
      error: 'Token refresh failed',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * POST /api/auth/logout
 * Invalidate the current session
 */
router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.cookies?.sessionId;

    if (sessionId) {
      await auth.invalidateSession(sessionId);
    }

    // Clear cookies
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.clearCookie('sessionId', { path: '/api/auth' });

    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    // Still clear cookies even on error
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.clearCookie('sessionId', { path: '/api/auth' });
    res.json({ message: 'Logged out' });
  }
});

/**
 * GET /api/auth/me
 * Get current user info
 * Requires authentication
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    // req.user is set by requireAuth middleware
    const user = await auth.getUserById(req.user.id);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.json({
      user: {
        id: user.id,
        username: user.paperless_username,
        displayName: user.display_name,
        role: user.role,
        createdAt: user.created_at
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({
      error: 'Failed to get user info',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * GET /api/auth/families
 * Get all available family tags (for family selector dropdown)
 * Requires authentication
 */
router.get('/families', requireAuth, async (req, res) => {
  try {
    // Get user's Paperless token
    const user = await auth.getUserById(req.user.id);
    if (!user || !user.paperless_token) {
      return res.status(401).json({
        error: 'Paperless authentication required',
        code: 'NO_PAPERLESS_TOKEN'
      });
    }

    // Fetch families from Paperless
    const families = await auth.fetchUserFamilies(user.paperless_token);

    res.json({ families });
  } catch (err) {
    console.error('Get families error:', err);
    res.status(500).json({
      error: 'Failed to get families',
      code: 'SERVER_ERROR'
    });
  }
});

module.exports = router;
