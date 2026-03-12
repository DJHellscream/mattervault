-- Prompt templates for Quick Actions
CREATE TABLE IF NOT EXISTS prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(100) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  icon VARCHAR(50) NOT NULL DEFAULT 'file-text',
  prompt_text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_sort ON prompt_templates (sort_order);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_enabled ON prompt_templates (enabled);

-- Seed 5 default prompts
INSERT INTO prompt_templates (title, description, icon, prompt_text, sort_order, is_default, enabled)
VALUES
  ('Summarize Key Terms', 'Structured summary of provisions, parties, dates, and obligations', 'file-text', 'Provide a structured summary of the key terms across all documents, including parties, dates, obligations, and notable provisions.', 1, true, true),
  ('Flag Issues & Concerns', 'Identify ambiguous language, conflicts, and gaps needing review', 'alert-triangle', 'Review all documents and identify potential issues, risks, or concerns such as ambiguous language, missing contingencies, conflicting terms, or gaps that may need attorney review.', 2, true, true),
  ('List All Documents', 'Overview of every document with type, date, and purpose', 'list', 'List every document in this family''s vault with its type, date, and a brief description of its purpose.', 3, true, true),
  ('Timeline of Events', 'Chronological timeline of dates and milestones with citations', 'clock', 'Extract a chronological timeline of all significant events, dates, and milestones from the documents, citing the source document for each entry.', 4, true, true),
  ('Identify Parties & Roles', 'Every person and entity with their roles and relationships', 'users', 'Identify every person and entity mentioned across all documents, their roles, which documents they appear in, and relationships between them.', 5, true, true)
ON CONFLICT DO NOTHING;
