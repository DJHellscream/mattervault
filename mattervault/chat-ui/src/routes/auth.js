/**
 * Authentication routes
 * Login, register, logout, refresh, me endpoints
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

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 registrations per hour per IP
  message: { error: 'Too many registration attempts. Please try again later.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/auth/register
 * Create a new user account
 * Body: { email, password, family_id, display_name? }
 */
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, family_id, display_name } = req.body;

    // Validation
    if (!email || !password || !family_id) {
      return res.status(400).json({
        error: 'Email, password, and family_id are required',
        code: 'VALIDATION_ERROR'
      });
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Invalid email format',
        code: 'INVALID_EMAIL'
      });
    }

    // Password strength check (min 8 chars)
    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters',
        code: 'WEAK_PASSWORD'
      });
    }

    // Check if user already exists
    const existingUser = await auth.getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error: 'An account with this email already exists',
        code: 'EMAIL_EXISTS'
      });
    }

    // Create user
    const user = await auth.createUser({
      email,
      password,
      familyId: family_id,
      displayName: display_name
    });

    // Generate tokens
    const accessToken = auth.generateAccessToken(user);
    const refreshToken = auth.generateRefreshToken();
    const sessionId = await auth.createSession(user.id, refreshToken);

    // Set refresh token in httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/auth'
    });

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/auth'
    });

    res.status(201).json({
      message: 'Account created successfully',
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        familyId: user.family_id,
        displayName: user.display_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({
      error: 'Registration failed',
      code: 'SERVER_ERROR'
    });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and return tokens
 * Body: { email, password }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required',
        code: 'VALIDATION_ERROR'
      });
    }

    // Find user
    const user = await auth.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Verify password
    const validPassword = await auth.verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Generate tokens
    const accessToken = auth.generateAccessToken(user);
    const refreshToken = auth.generateRefreshToken();
    const sessionId = await auth.createSession(user.id, refreshToken);

    // Set refresh token in httpOnly cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/auth'
    });

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/auth'
    });

    res.json({
      message: 'Login successful',
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        familyId: user.family_id,
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
        email: user.email,
        familyId: user.family_id,
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
        email: user.email,
        familyId: user.family_id,
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

module.exports = router;
