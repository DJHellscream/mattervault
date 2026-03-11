-- Migration 006: Add family_id mismatch tracking to reconciliation
-- Supports the enhanced reconciliation workflow that detects and corrects
-- family_id mismatches between Paperless tags and Qdrant payloads.

-- Allow 'update_family' as a reconciliation operation type
ALTER TABLE sync.reconciliation_log DROP CONSTRAINT IF EXISTS reconciliation_log_operation_check;
ALTER TABLE sync.reconciliation_log ADD CONSTRAINT reconciliation_log_operation_check
    CHECK (operation IN ('delete', 'ingest', 'skip', 'verify', 'update_family'));

-- Track family update count in reconciliation state
ALTER TABLE sync.reconciliation_state ADD COLUMN IF NOT EXISTS documents_family_updated INT DEFAULT 0;

-- Update complete_reconciliation function to accept family_updated count
CREATE OR REPLACE FUNCTION sync.complete_reconciliation(
    p_run_id INT,
    p_status VARCHAR,
    p_high_water_mark TIMESTAMPTZ,
    p_checked INT,
    p_deleted INT,
    p_ingested INT,
    p_error TEXT DEFAULT NULL,
    p_family_updated INT DEFAULT 0
)
RETURNS VOID AS $$
BEGIN
    UPDATE sync.reconciliation_state
    SET
        completed_at = NOW(),
        status = p_status,
        high_water_mark = p_high_water_mark,
        documents_checked = p_checked,
        documents_deleted = p_deleted,
        documents_ingested = p_ingested,
        documents_family_updated = p_family_updated,
        last_success_at = CASE WHEN p_status = 'success' THEN NOW() ELSE last_success_at END,
        error_message = p_error
    WHERE id = p_run_id;
END;
$$ LANGUAGE plpgsql;
