-- Per-family access control (ethical walls)
-- Admins bypass this table and see all families.
-- Regular users only see families with a row in this table.

CREATE TABLE IF NOT EXISTS user_family_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, family_id)
);

CREATE INDEX IF NOT EXISTS idx_user_family_access_user ON user_family_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_family_access_family ON user_family_access(family_id);
