-- Mattervault Chat UI - Audit Logging Migration
-- Immutable audit trail for chat queries with 7-year retention
-- Monthly partitioned for performance

-- Create audit schema
CREATE SCHEMA IF NOT EXISTS audit;

-- Create partitioned audit log table
-- Note: Primary key must include partition column (created_at) for partitioned tables
CREATE TABLE IF NOT EXISTS audit.chat_query_logs (
    id UUID DEFAULT gen_random_uuid(),

    -- Correlation tracking
    correlation_id UUID NOT NULL,
    n8n_execution_id VARCHAR(100),

    -- User context
    user_id UUID NOT NULL,
    paperless_username VARCHAR(150),
    client_ip INET,
    user_agent TEXT,

    -- Query context
    family_id VARCHAR(100) NOT NULL,
    conversation_id UUID,

    -- Query and response
    query_text TEXT NOT NULL,
    response_text TEXT,

    -- Document tracking (JSONB for flexibility)
    documents_retrieved JSONB,  -- All docs returned by search
    documents_cited JSONB,      -- Docs actually cited in response

    -- Performance metrics
    total_latency_ms INTEGER,

    -- Timestamp (partition key)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Composite primary key must include partition column
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create indexes on parent table (will be inherited by partitions)
CREATE INDEX IF NOT EXISTS idx_audit_correlation_id ON audit.chat_query_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit.chat_query_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_family_id ON audit.chat_query_logs(family_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit.chat_query_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_paperless_username ON audit.chat_query_logs(paperless_username);

-- Immutability trigger - prevents UPDATE and DELETE
CREATE OR REPLACE FUNCTION audit.prevent_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs are immutable. UPDATE and DELETE operations are not permitted.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Apply immutability trigger
DROP TRIGGER IF EXISTS audit_immutable_trigger ON audit.chat_query_logs;
CREATE TRIGGER audit_immutable_trigger
    BEFORE UPDATE OR DELETE ON audit.chat_query_logs
    FOR EACH ROW
    EXECUTE FUNCTION audit.prevent_modification();

-- Create monthly partitions for 2026-01 through 2027-12
-- 2026 partitions
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_01 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_02 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_03 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_04 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_05 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_06 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_07 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_08 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_09 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_10 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_11 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2026_12 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- 2027 partitions
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_01 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_02 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_03 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_04 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_05 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_06 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_07 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_08 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_09 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_10 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_11 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS audit.chat_query_logs_2027_12 PARTITION OF audit.chat_query_logs
    FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

-- Grant usage on audit schema to app user (adjust username as needed)
-- GRANT USAGE ON SCHEMA audit TO chatui_app;
-- GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA audit TO chatui_app;
