-- Mattervault Document Sync - Schema Migration
-- Tracks reconciliation state and logs sync operations

-- Create sync schema
CREATE SCHEMA IF NOT EXISTS sync;

-- High-water mark tracking for incremental reconciliation
CREATE TABLE IF NOT EXISTS sync.reconciliation_state (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL,  -- 'incremental' or 'full'
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    high_water_mark TIMESTAMPTZ,     -- Last processed timestamp for incremental
    documents_checked INT NOT NULL DEFAULT 0,
    documents_deleted INT NOT NULL DEFAULT 0,
    documents_ingested INT NOT NULL DEFAULT 0,
    status VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    error_message TEXT
);

CREATE INDEX idx_reconciliation_state_type ON sync.reconciliation_state(sync_type);
CREATE INDEX idx_reconciliation_state_started ON sync.reconciliation_state(started_at DESC);
CREATE INDEX idx_reconciliation_state_status ON sync.reconciliation_state(status);

-- Detailed log of each sync operation
CREATE TABLE IF NOT EXISTS sync.reconciliation_log (
    id SERIAL PRIMARY KEY,
    run_id INT NOT NULL REFERENCES sync.reconciliation_state(id) ON DELETE CASCADE,
    operation VARCHAR(20) NOT NULL CHECK (operation IN ('delete', 'ingest', 'skip', 'verify')),
    document_id VARCHAR(50) NOT NULL,
    document_title TEXT,
    family_id VARCHAR(100),
    status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reconciliation_log_run_id ON sync.reconciliation_log(run_id);
CREATE INDEX idx_reconciliation_log_document_id ON sync.reconciliation_log(document_id);
CREATE INDEX idx_reconciliation_log_created_at ON sync.reconciliation_log(created_at);

-- Function to get the last successful high-water mark
CREATE OR REPLACE FUNCTION sync.get_last_high_water_mark()
RETURNS TIMESTAMPTZ AS $$
BEGIN
    RETURN (
        SELECT high_water_mark
        FROM sync.reconciliation_state
        WHERE status = 'success' AND high_water_mark IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
    );
END;
$$ LANGUAGE plpgsql;

-- Function to start a new reconciliation run
CREATE OR REPLACE FUNCTION sync.start_reconciliation(p_sync_type VARCHAR)
RETURNS INT AS $$
DECLARE
    v_run_id INT;
BEGIN
    INSERT INTO sync.reconciliation_state (sync_type, started_at, status)
    VALUES (p_sync_type, NOW(), 'running')
    RETURNING id INTO v_run_id;
    RETURN v_run_id;
END;
$$ LANGUAGE plpgsql;

-- Function to complete a reconciliation run
CREATE OR REPLACE FUNCTION sync.complete_reconciliation(
    p_run_id INT,
    p_status VARCHAR,
    p_high_water_mark TIMESTAMPTZ,
    p_checked INT,
    p_deleted INT,
    p_ingested INT,
    p_error TEXT DEFAULT NULL
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
        last_success_at = CASE WHEN p_status = 'success' THEN NOW() ELSE last_success_at END,
        error_message = p_error
    WHERE id = p_run_id;
END;
$$ LANGUAGE plpgsql;
