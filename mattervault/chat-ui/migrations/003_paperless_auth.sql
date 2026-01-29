-- Mattervault Chat UI - Paperless Authentication Migration
-- Replaces local password auth with Paperless-ngx as identity provider

-- Add Paperless integration fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS paperless_user_id INTEGER UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS paperless_username VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS paperless_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP;

-- Make email nullable (Paperless username is now primary identifier)
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- Make password_hash nullable (keeping for potential rollback, not used)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Make family_id nullable (now stored per-conversation, not per-user)
ALTER TABLE users ALTER COLUMN family_id DROP NOT NULL;

-- Index for Paperless username lookups
CREATE INDEX IF NOT EXISTS idx_users_paperless_username ON users(paperless_username);
CREATE INDEX IF NOT EXISTS idx_users_paperless_user_id ON users(paperless_user_id);
