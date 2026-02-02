#!/bin/bash
# ==============================================================================
# Mattervault E2E Test - Runs INSIDE Docker network
# Usage: docker exec e2e-runner /e2e/test.sh [reset|test|full|sync|audit|all]
#   reset - Clear all data
#   test  - Run tests only (use existing data)
#   full  - Reset + ingest + test (default)
#   sync  - Run document sync tests
#   audit - Run audit system tests
#   all   - Full test suite including sync + audit
# ==============================================================================
set -euo pipefail

# Internal Docker hostnames (reliable, no networking guesswork)
PAPERLESS_URL="http://mattervault:8000"
N8N_URL="http://matterlogic:5678"
QDRANT_URL="http://qdrant:6333"
CHATUI_DB="postgresql://chatui:chatui_secure_pass@matterdb-chatui:5432/chatui"
PAPERLESS_DB="postgresql://paperless:paperless_secure_pass@matterdb-paperless:5432/paperless"

# Native services via Docker gateway
OLLAMA_URL="http://host.docker.internal:11434"
DOCLING_URL="http://host.docker.internal:5001"

# Credentials
PAPERLESS_USER="admin"
PAPERLESS_PASS="${PAPERLESS_PASS:-mattervault2025}"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

# Test counters
PASSED=0; FAILED=0; WARNINGS=0

pass() { echo -e "${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
warn() { echo -e "${YELLOW}!${NC} $1"; WARNINGS=$((WARNINGS + 1)); }
info() { echo -e "${BLUE}→${NC} $1"; }
header() { echo -e "\n${YELLOW}=== $1 ===${NC}"; }

# ==============================================================================
# HEALTH CHECK
# ==============================================================================
check_health() {
    header "Health Check"

    # Docker services (internal network)
    curl -sf "$PAPERLESS_URL/api/" >/dev/null && pass "Paperless" || fail "Paperless not responding"
    curl -sf "$N8N_URL/healthz" >/dev/null && pass "n8n" || fail "n8n not responding"
    curl -sf "$QDRANT_URL/collections" >/dev/null && pass "Qdrant" || fail "Qdrant not responding"
    psql "$CHATUI_DB" -c "SELECT 1" >/dev/null 2>&1 && pass "ChatUI DB" || fail "ChatUI DB not responding"

    # Native services (host gateway)
    curl -sf "$OLLAMA_URL/api/tags" >/dev/null && pass "Ollama (native)" || fail "Ollama not responding"
    curl -sf "$DOCLING_URL/health" >/dev/null && pass "Docling (native)" || fail "Docling not responding"

    if [ $FAILED -gt 0 ]; then
        echo -e "\n${RED}Health check failed. Fix services before continuing.${NC}"
        exit 1
    fi
}

# ==============================================================================
# RESET (Clear all data)
# ==============================================================================
do_reset() {
    header "Reset: Clearing All Data"

    # 1. Get Paperless token
    info "Authenticating with Paperless..."
    TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | jq -r '.token // empty')

    # Step 1: Empty existing trash FIRST (from previous runs - blocks duplicate detection!)
    info "Emptying existing Paperless trash..."
    psql "$PAPERLESS_DB" -c "
        DELETE FROM documents_workflowrun WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
        DELETE FROM documents_document_tags WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
        DELETE FROM documents_note WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
        DELETE FROM documents_document WHERE deleted_at IS NOT NULL;
    " >/dev/null 2>&1 || true

    if [ -n "$TOKEN" ]; then
        # Step 2: Delete current documents via API (moves to trash)
        info "Deleting Paperless documents via API..."
        DOC_IDS=$(curl -sf "$PAPERLESS_URL/api/documents/" -H "Authorization: Token $TOKEN" | jq -r '.results[].id // empty')
        for id in $DOC_IDS; do
            curl -sf -X DELETE "$PAPERLESS_URL/api/documents/$id/" -H "Authorization: Token $TOKEN" >/dev/null 2>&1 || true
        done
        [ -n "$DOC_IDS" ] && info "Deleted $(echo "$DOC_IDS" | wc -w) document(s) via API"

        # Step 3: Empty trash again (for newly deleted docs)
        info "Emptying Paperless trash..."
        psql "$PAPERLESS_DB" -c "
            DELETE FROM documents_workflowrun WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
            DELETE FROM documents_document_tags WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
            DELETE FROM documents_note WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
            DELETE FROM documents_document WHERE deleted_at IS NOT NULL;
        " >/dev/null 2>&1
        pass "Paperless cleared (trash emptied + API delete + trash emptied)"
    else
        # Still empty trash even without token
        pass "Paperless trash emptied (no active documents)"
    fi

    # 2. Clear Qdrant
    info "Clearing Qdrant vectors..."
    curl -sf -X DELETE "$QDRANT_URL/collections/mattervault_documents" >/dev/null 2>&1 || true
    curl -sf -X DELETE "$QDRANT_URL/collections/mattervault_documents_v2" >/dev/null 2>&1 || true

    # Recreate V2 collection
    curl -sf -X PUT "$QDRANT_URL/collections/mattervault_documents_v2" \
        -H "Content-Type: application/json" \
        -d '{"vectors":{"dense":{"size":768,"distance":"Cosine"}},"sparse_vectors":{"bm25":{"modifier":"idf"}}}' >/dev/null

    # Create indexes
    for field in family_id document_id; do
        curl -sf -X PUT "$QDRANT_URL/collections/mattervault_documents_v2/index" \
            -H "Content-Type: application/json" \
            -d "{\"field_name\":\"$field\",\"field_schema\":\"keyword\"}" >/dev/null 2>&1 || true
    done
    pass "Qdrant cleared and recreated"

    # 3. Clear ChatUI database (preserve users)
    info "Clearing ChatUI database..."
    psql "$CHATUI_DB" -c "
        TRUNCATE TABLE messages CASCADE;
        TRUNCATE TABLE conversations CASCADE;
        TRUNCATE TABLE sessions CASCADE;
        -- Clear audit partitions
        DO \$\$
        DECLARE p TEXT;
        BEGIN
            FOR p IN SELECT tablename FROM pg_tables WHERE schemaname='audit' AND tablename LIKE 'chat_query_logs_%'
            LOOP EXECUTE 'TRUNCATE TABLE audit.' || p; END LOOP;
        END \$\$;
    " >/dev/null 2>&1
    pass "ChatUI database cleared (users preserved)"

    # 4. Clear intake folder
    rm -rf /files/intake/morrison/* /files/intake/johnson/* 2>/dev/null || true
    mkdir -p /files/intake/morrison /files/intake/johnson 2>/dev/null || true
    pass "Intake folder cleared"

    echo -e "\n${GREEN}Reset complete.${NC}"
}

# ==============================================================================
# INGEST (Copy test file and wait for processing)
# ==============================================================================
do_ingest() {
    header "Ingestion: Morrison Family Profile"

    # Copy test file
    DEMO_FILE="/files/demo/Morrison Demo Data/00_Morrison_Family_Profile.pdf"
    if [ ! -f "$DEMO_FILE" ]; then
        fail "Demo file not found: $DEMO_FILE"
        echo "Mount demo data volume to /files/demo"
        return 1
    fi

    cp "$DEMO_FILE" /files/intake/morrison/
    info "Copied test PDF to intake/morrison/"

    # Wait for Paperless to process
    info "Waiting for Paperless ingestion..."
    TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | jq -r '.token')

    for i in {1..30}; do
        DOC_COUNT=$(curl -sf "$PAPERLESS_URL/api/documents/" -H "Authorization: Token $TOKEN" | jq -r '.count // 0')
        if [ "$DOC_COUNT" -gt 0 ]; then
            pass "Paperless processed $DOC_COUNT document(s)"
            break
        fi
        sleep 10
        echo -n "."
    done
    echo ""

    # Wait for vectors
    info "Waiting for vector indexing..."
    for i in {1..30}; do
        VECTOR_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v2" | jq -r '.result.points_count // 0')
        if [ "$VECTOR_COUNT" -gt 0 ]; then
            pass "Qdrant indexed $VECTOR_COUNT vectors"
            break
        fi
        sleep 10
        echo -n "."
    done
    echo ""

    if [ "$VECTOR_COUNT" -eq 0 ]; then
        fail "Vector indexing timed out"
        return 1
    fi
}

# ==============================================================================
# TEST (Run chat queries)
# ==============================================================================
do_test() {
    header "Chat API Tests"

    # Get valid user_id
    USER_ID=$(psql "$CHATUI_DB" -t -A -c "SELECT id FROM users WHERE paperless_username='admin' LIMIT 1" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$USER_ID" ]; then
        fail "No admin user in ChatUI database"
        info "Login via chat-ui first to create user"
        return 1
    fi
    info "Using user_id: $USER_ID"

    # Test questions
    run_test() {
        local name="$1"
        local question="$2"
        local pattern="$3"

        echo ""
        info "Test: $name"

        RESPONSE=$(curl -sf --max-time 120 "$N8N_URL/webhook/chat-api-v3" \
            -H "Content-Type: application/json" \
            -d "{\"question\":\"$question\",\"family_id\":\"morrison\",\"user_id\":\"$USER_ID\"}" 2>&1 || echo '{"error":"timeout"}')

        OUTPUT=$(echo "$RESPONSE" | jq -r '.output // .message // "no output"' 2>/dev/null || echo "$RESPONSE")

        if echo "$OUTPUT" | grep -qiE "$pattern"; then
            pass "$name"
            echo "   ${OUTPUT:0:100}..."
        else
            fail "$name"
            echo "   Expected: $pattern"
            echo "   Got: ${OUTPUT:0:150}"
        fi
    }

    run_test "Key Events" "What are the key events?" "1972|Harold|Eleanor|marry"
    run_test "Address" "What is Harold's address?" "Willowbrook|8742|Indianapolis"
    run_test "Children" "Who are Harold's children?" "David|Katie|Rob"
    run_test "Business Sale" "When was Morrison Manufacturing sold?" "2019|47"
}

# ==============================================================================
# VERIFY (Check data integrity)
# ==============================================================================
do_verify() {
    header "Data Verification"

    # Vector count
    VECTORS=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v2" | jq -r '.result.points_count // 0')
    [ "$VECTORS" -gt 20 ] && pass "Vectors: $VECTORS" || warn "Low vector count: $VECTORS"

    # Audit logs
    AUDITS=$(psql "$CHATUI_DB" -t -A -c "SELECT COUNT(*) FROM audit.chat_query_logs WHERE created_at > NOW() - INTERVAL '10 minutes'" 2>/dev/null || echo "0")
    [ "$AUDITS" -ge 4 ] && pass "Audit logs: $AUDITS" || warn "Audit logs: $AUDITS (expected 4+)"

    # Conversations
    CONVS=$(psql "$CHATUI_DB" -t -A -c "SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL '10 minutes'" 2>/dev/null || echo "0")
    [ "$CONVS" -ge 1 ] && pass "Conversations: $CONVS" || warn "No conversations"
}

# ==============================================================================
# SYNC TESTS
# ==============================================================================
do_sync_tests() {
    header "Document Sync Tests"

    # Get auth token
    TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | jq -r '.token')

    # Test 1: Idempotent re-ingestion (no duplicates)
    info "Test: Idempotent re-ingestion"
    BEFORE_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v2" | jq -r '.result.points_count')

    # Get first document ID
    DOC_ID=$(curl -sf "$PAPERLESS_URL/api/documents/" -H "Authorization: Token $TOKEN" | jq -r '.results[0].id')

    if [ -n "$DOC_ID" ] && [ "$DOC_ID" != "null" ]; then
        # Trigger re-ingestion
        curl -sf -X POST "$N8N_URL/webhook/document-added-v2" \
            -H "Content-Type: application/json" \
            -d "{\"doc_url\":\"http://paperless:8000/api/documents/$DOC_ID/\"}" >/dev/null

        sleep 60  # Wait for ingestion (Docling parsing + embedding can take time)

        AFTER_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v2" | jq -r '.result.points_count')

        if [ "$BEFORE_COUNT" -eq "$AFTER_COUNT" ]; then
            pass "Idempotent re-ingestion (count unchanged: $BEFORE_COUNT)"
        else
            fail "Idempotent re-ingestion (before: $BEFORE_COUNT, after: $AFTER_COUNT)"
        fi
    else
        warn "No documents to test re-ingestion"
    fi

    # Test 2: Sync schema exists
    info "Test: Sync schema exists"
    SCHEMA_EXISTS=$(psql "$CHATUI_DB" -t -A -c "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'sync')" 2>/dev/null || echo "f")
    if [ "$SCHEMA_EXISTS" = "t" ]; then
        pass "Sync schema exists"
    else
        fail "Sync schema not found"
    fi

    # Test 3: Reconciliation tables exist
    info "Test: Reconciliation tables exist"
    TABLES_EXIST=$(psql "$CHATUI_DB" -t -A -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'sync'" 2>/dev/null || echo "0")
    if [ "$TABLES_EXIST" -ge 2 ]; then
        pass "Reconciliation tables exist ($TABLES_EXIST tables)"
    else
        fail "Reconciliation tables missing (found: $TABLES_EXIST)"
    fi
}

# ==============================================================================
# AUDIT TESTS
# ==============================================================================
do_audit_tests() {
    header "Audit System Tests"

    # Test 1: Audit schema exists
    info "Test: Audit schema exists"
    SCHEMA_EXISTS=$(psql "$CHATUI_DB" -t -A -c "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'audit')" 2>/dev/null || echo "f")
    if [ "$SCHEMA_EXISTS" = "t" ]; then
        pass "Audit schema exists"
    else
        fail "Audit schema not found"
        return 1
    fi

    # Test 2: Audit partitions exist
    info "Test: Audit partitions exist"
    PARTITION_COUNT=$(psql "$CHATUI_DB" -t -A -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'audit' AND tablename LIKE 'chat_query_logs_%'" 2>/dev/null || echo "0")
    if [ "$PARTITION_COUNT" -ge 1 ]; then
        pass "Audit partitions exist ($PARTITION_COUNT partitions)"
    else
        fail "No audit partitions found"
    fi

    # Test 3: Audit logs contain data (from previous chat tests)
    info "Test: Audit logs contain data"
    AUDIT_COUNT=$(psql "$CHATUI_DB" -t -A -c "SELECT COUNT(*) FROM audit.chat_query_logs WHERE created_at > NOW() - INTERVAL '1 hour'" 2>/dev/null || echo "0")
    if [ "$AUDIT_COUNT" -ge 1 ]; then
        pass "Audit logs contain data ($AUDIT_COUNT recent entries)"
    else
        warn "No recent audit entries (run chat tests first)"
    fi

    # Test 4: Audit log fields are populated
    info "Test: Audit log fields populated"
    COMPLETE_LOGS=$(psql "$CHATUI_DB" -t -A -c "
        SELECT COUNT(*) FROM audit.chat_query_logs
        WHERE created_at > NOW() - INTERVAL '1 hour'
        AND correlation_id IS NOT NULL
        AND query_text IS NOT NULL
        AND family_id IS NOT NULL
    " 2>/dev/null || echo "0")
    if [ "$COMPLETE_LOGS" -ge 1 ]; then
        pass "Audit logs have required fields ($COMPLETE_LOGS complete entries)"
    else
        warn "No complete audit entries found"
    fi

    # Test 5: Get ChatUI admin token for API tests
    info "Test: ChatUI admin authentication"

    # First login to Paperless to validate credentials
    PAPERLESS_TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | jq -r '.token // empty')

    if [ -z "$PAPERLESS_TOKEN" ]; then
        fail "Could not authenticate with Paperless"
        return 1
    fi

    # Login to ChatUI
    CHATUI_URL="http://mattervault-chat:3000"
    LOGIN_RESPONSE=$(curl -sf "$CHATUI_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" 2>&1 || echo '{"error":"failed"}')

    CHATUI_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.accessToken // empty')

    if [ -n "$CHATUI_TOKEN" ] && [ "$CHATUI_TOKEN" != "null" ]; then
        pass "ChatUI admin authentication"
    else
        warn "ChatUI login failed (may need to login via browser first)"
        # Continue with other tests
    fi

    # Test 6: Audit recent API endpoint (if authenticated)
    if [ -n "$CHATUI_TOKEN" ] && [ "$CHATUI_TOKEN" != "null" ]; then
        info "Test: Audit recent API"
        RECENT_RESPONSE=$(curl -sf "$CHATUI_URL/api/audit/recent?limit=5" \
            -H "Authorization: Bearer $CHATUI_TOKEN" 2>&1 || echo '{"error":"failed"}')

        if echo "$RECENT_RESPONSE" | jq -e '.logs' >/dev/null 2>&1; then
            RECENT_COUNT=$(echo "$RECENT_RESPONSE" | jq -r '.logs | length')
            pass "Audit recent API ($RECENT_COUNT entries)"
        else
            ERROR_MSG=$(echo "$RECENT_RESPONSE" | jq -r '.error // .message // "unknown"')
            fail "Audit recent API failed: $ERROR_MSG"
        fi

        # Test 7: Audit summary API endpoint
        info "Test: Audit summary API"
        SUMMARY_RESPONSE=$(curl -sf "$CHATUI_URL/api/audit/summary?group_by=family" \
            -H "Authorization: Bearer $CHATUI_TOKEN" 2>&1 || echo '{"error":"failed"}')

        if echo "$SUMMARY_RESPONSE" | jq -e '.summary' >/dev/null 2>&1; then
            pass "Audit summary API"
        else
            ERROR_MSG=$(echo "$SUMMARY_RESPONSE" | jq -r '.error // .message // "unknown"')
            fail "Audit summary API failed: $ERROR_MSG"
        fi
    else
        warn "Skipping API tests (no auth token)"
    fi

    # Test 8: Verify audit partition maintenance tables
    info "Test: Future partitions prepared"
    FUTURE_PARTITIONS=$(psql "$CHATUI_DB" -t -A -c "
        SELECT COUNT(*) FROM pg_tables
        WHERE schemaname = 'audit'
        AND tablename LIKE 'chat_query_logs_%'
        AND tablename > 'chat_query_logs_' || to_char(NOW(), 'YYYY_MM')
    " 2>/dev/null || echo "0")
    if [ "$FUTURE_PARTITIONS" -ge 1 ]; then
        pass "Future partitions exist ($FUTURE_PARTITIONS)"
    else
        warn "No future partitions (run partition maintenance)"
    fi
}

# ==============================================================================
# MAIN
# ==============================================================================
MODE="${1:-full}"

echo "========================================"
echo "  Mattervault E2E Test"
echo "  Mode: $MODE"
echo "========================================"

check_health

case "$MODE" in
    reset)
        do_reset
        ;;
    test)
        do_test
        do_verify
        ;;
    full)
        do_reset
        do_ingest
        do_test
        do_verify
        ;;
    sync)
        do_sync_tests
        ;;
    audit)
        do_audit_tests
        ;;
    all)
        do_reset
        do_ingest
        do_test
        do_verify
        do_sync_tests
        do_audit_tests
        ;;
    *)
        echo "Usage: $0 [reset|test|full|sync|audit|all]"
        exit 1
        ;;
esac

# Summary
echo ""
echo "========================================"
echo "  Summary"
echo "========================================"
echo -e "Passed:   ${GREEN}$PASSED${NC}"
echo -e "Failed:   ${RED}$FAILED${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"

[ $FAILED -eq 0 ] && echo -e "\n${GREEN}All tests passed!${NC}" || echo -e "\n${RED}Some tests failed.${NC}"
exit $FAILED
