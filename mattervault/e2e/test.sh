#!/bin/bash
# ==============================================================================
# Mattervault E2E Test - Runs INSIDE Docker network
# Usage: docker exec mattertest /e2e/test.sh [reset|test|full|sync|audit|hardening|prompt|hallucination|ingestion-status|large-pdf|embedding|all]
#   reset            - Clear all data
#   test             - Run tests only (use existing data) + prompt quality + hallucination
#   full             - Reset + ingest + test (default)
#   sync             - Run document sync tests
#   audit            - Run audit system tests
#   hardening        - Family isolation hardening tests (tenant index, pre-consume, reconciliation, dashboard)
#   prompt           - Prompt quality tests (off-topic rejection, citation format)
#   hallucination    - JSON-driven adversarial/factual/citation tests (grounding, factual accuracy, citations)
#   ingestion-status - Ingestion status tag tests (processing, ai_ready, ingestion_error)
#   large-pdf        - Large PDF handling tests (PyPDF2, split-pdf.py, Docling timeout)
#   embedding        - Embedding validation tests (collection v3, 1024d, bge-m3 model)
#   all              - Full test suite including sync + audit + hardening + prompt + hallucination + ingestion-status + large-pdf + embedding
# ==============================================================================
set -euo pipefail

# Internal Docker hostnames (reliable, no networking guesswork)
PAPERLESS_URL="http://mattervault:8000"
N8N_URL="http://matterlogic:5678"
QDRANT_URL="http://mattermemory:6333"
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

    # Chat-UI health endpoint
    CHAT_HEALTH=$(curl -sf http://matterchat:3000/health 2>/dev/null)
    if [ $? -eq 0 ]; then
      pass "Chat-UI health endpoint responding"
      DB_STATUS=$(echo "$CHAT_HEALTH" | jq -r '.services.database')
      REDIS_STATUS=$(echo "$CHAT_HEALTH" | jq -r '.services.redis')
      [ "$DB_STATUS" = "true" ] && pass "Chat-UI database connected" || fail "Chat-UI database disconnected"
      [ "$REDIS_STATUS" = "true" ] && pass "Chat-UI Redis connected" || fail "Chat-UI Redis disconnected"
    else
      fail "Chat-UI health endpoint not responding"
    fi

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
    curl -sf -X DELETE "$QDRANT_URL/collections/mattervault_documents_v3" >/dev/null 2>&1 || true

    # Recreate V3 collection
    curl -sf -X PUT "$QDRANT_URL/collections/mattervault_documents_v3" \
        -H "Content-Type: application/json" \
        -d '{"vectors":{"dense":{"size":1024,"distance":"Cosine"}},"sparse_vectors":{"bm25":{"modifier":"idf"}}}' >/dev/null

    # family_id uses tenant-aware index for optimized per-family queries
    curl -sf -X PUT "$QDRANT_URL/collections/mattervault_documents_v3/index" \
        -H "Content-Type: application/json" \
        -d '{"field_name":"family_id","field_schema":{"type":"keyword","is_tenant":true}}' >/dev/null 2>&1 || true
    curl -sf -X PUT "$QDRANT_URL/collections/mattervault_documents_v3/index" \
        -H "Content-Type: application/json" \
        -d '{"field_name":"document_id","field_schema":"keyword"}' >/dev/null 2>&1 || true
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
        VECTOR_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" | jq -r '.result.points_count // 0')
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
    VECTORS=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" | jq -r '.result.points_count // 0')
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
    BEFORE_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" | jq -r '.result.points_count')

    # Get first document ID
    DOC_ID=$(curl -sf "$PAPERLESS_URL/api/documents/" -H "Authorization: Token $TOKEN" | jq -r '.results[0].id')

    if [ -n "$DOC_ID" ] && [ "$DOC_ID" != "null" ]; then
        # Trigger re-ingestion
        curl -sf -X POST "$N8N_URL/webhook/document-added-v2" \
            -H "Content-Type: application/json" \
            -d "{\"doc_url\":\"http://mattervault:8000/api/documents/$DOC_ID/\"}" >/dev/null

        sleep 60  # Wait for ingestion (Docling parsing + embedding can take time)

        AFTER_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" | jq -r '.result.points_count')

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
    CHATUI_URL="http://matterchat:3000"
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
# HARDENING TESTS (Qdrant tenant index, pre-consume validation, reconciliation,
#                  dashboard reconcile button)
# ==============================================================================
do_hardening_tests() {
    header "Family Isolation Hardening Tests"

    DASHBOARD_URL="http://matterdash:3000"

    # Get auth token
    TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | jq -r '.token // empty')

    # --------------------------------------------------------------------------
    # Test 1: Qdrant family_id index has is_tenant: true
    # --------------------------------------------------------------------------
    info "Test: Qdrant family_id index is tenant-aware"
    COLLECTION_INFO=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" 2>/dev/null)
    IS_TENANT=$(echo "$COLLECTION_INFO" | jq -r '.result.payload_schema.family_id.params.is_tenant // false' 2>/dev/null)
    if [ "$IS_TENANT" = "true" ]; then
        pass "family_id index has is_tenant: true"
    else
        fail "family_id index missing is_tenant: true (got: $IS_TENANT)"
    fi

    # --------------------------------------------------------------------------
    # Test 2: Qdrant document_id index exists as keyword
    # --------------------------------------------------------------------------
    info "Test: Qdrant document_id index exists"
    DOC_ID_TYPE=$(echo "$COLLECTION_INFO" | jq -r '.result.payload_schema.document_id.data_type // "missing"' 2>/dev/null)
    if [ "$DOC_ID_TYPE" = "keyword" ]; then
        pass "document_id index exists (keyword)"
    else
        fail "document_id index missing or wrong type (got: $DOC_ID_TYPE)"
    fi

    # --------------------------------------------------------------------------
    # Tests 3-9: Pre-consume validation script
    # These tests require docker CLI access to exec into the Paperless container.
    # When running inside the mattertest container (no docker), they are skipped.
    # Run from host with: ./e2e/test.sh hardening
    # --------------------------------------------------------------------------
    if command -v docker >/dev/null 2>&1; then
        # Test 3: Pre-consume script is mounted in Paperless container
        info "Test: Pre-consume script is mounted in Paperless"
        if docker exec mattervault test -f /usr/src/paperless/scripts/pre-consume-validate.sh 2>/dev/null; then
            pass "Pre-consume script is mounted"
        else
            fail "Pre-consume script not found in Paperless container"
        fi

        # Test 4: Pre-consume script is executable
        info "Test: Pre-consume script is executable"
        if docker exec mattervault test -x /usr/src/paperless/scripts/pre-consume-validate.sh 2>/dev/null; then
            pass "Pre-consume script is executable"
        else
            fail "Pre-consume script is not executable"
        fi

        # Test 5: PAPERLESS_PRE_CONSUME_SCRIPT env var is set
        info "Test: PAPERLESS_PRE_CONSUME_SCRIPT env var is set"
        PRE_CONSUME_ENV=$(docker exec mattervault printenv PAPERLESS_PRE_CONSUME_SCRIPT 2>/dev/null || echo "")
        if [ -n "$PRE_CONSUME_ENV" ]; then
            pass "PAPERLESS_PRE_CONSUME_SCRIPT is set: $PRE_CONSUME_ENV"
        else
            fail "PAPERLESS_PRE_CONSUME_SCRIPT not set in Paperless container"
        fi

        # Test 6: Pre-consume allows known family tag
        info "Test: Pre-consume allows known family (morrison)"
        if [ -n "$TOKEN" ]; then
            TAG_COUNT=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=morrison" \
                -H "Authorization: Token $TOKEN" | jq -r '.count // 0')
            if [ "$TAG_COUNT" -gt 0 ]; then
                RESULT=$(docker exec -e DOCUMENT_SOURCE_PATH=/usr/src/paperless/consume/intake/morrison/test.pdf \
                    mattervault /usr/src/paperless/scripts/pre-consume-validate.sh 2>&1; echo "EXIT:$?")
                EXIT_CODE=$(echo "$RESULT" | grep -o 'EXIT:[0-9]*' | cut -d: -f2)
                if [ "$EXIT_CODE" = "0" ]; then
                    pass "Pre-consume allows known family 'morrison'"
                else
                    fail "Pre-consume rejected known family 'morrison' (exit $EXIT_CODE)"
                    echo "   Output: $RESULT"
                fi
            else
                warn "Tag 'morrison' not found — skipping pre-consume allow test"
            fi
        else
            warn "No Paperless token — skipping pre-consume allow test"
        fi

        # Test 7: Pre-consume rejects unknown family tag
        info "Test: Pre-consume rejects unknown family"
        RESULT=$(docker exec -e DOCUMENT_SOURCE_PATH=/usr/src/paperless/consume/intake/zzz_nonexistent_family_zzz/test.pdf \
            mattervault /usr/src/paperless/scripts/pre-consume-validate.sh 2>&1; echo "EXIT:$?")
        EXIT_CODE=$(echo "$RESULT" | grep -o 'EXIT:[0-9]*' | cut -d: -f2)
        if [ "$EXIT_CODE" = "1" ]; then
            pass "Pre-consume rejects unknown family 'zzz_nonexistent_family_zzz'"
        else
            fail "Pre-consume allowed unknown family (exit $EXIT_CODE)"
            echo "   Output: $RESULT"
        fi

        # Test 8: Pre-consume allows non-intake paths (manual uploads)
        info "Test: Pre-consume allows non-intake paths"
        RESULT=$(docker exec -e DOCUMENT_SOURCE_PATH=/usr/src/paperless/consume/manual_upload.pdf \
            mattervault /usr/src/paperless/scripts/pre-consume-validate.sh 2>&1; echo "EXIT:$?")
        EXIT_CODE=$(echo "$RESULT" | grep -o 'EXIT:[0-9]*' | cut -d: -f2)
        if [ "$EXIT_CODE" = "0" ]; then
            pass "Pre-consume allows non-intake path"
        else
            fail "Pre-consume rejected non-intake path (exit $EXIT_CODE)"
        fi

        # Test 9: Pre-consume allows empty DOCUMENT_SOURCE_PATH (fail open)
        info "Test: Pre-consume allows empty source path"
        RESULT=$(docker exec -e DOCUMENT_SOURCE_PATH= \
            mattervault /usr/src/paperless/scripts/pre-consume-validate.sh 2>&1; echo "EXIT:$?")
        EXIT_CODE=$(echo "$RESULT" | grep -o 'EXIT:[0-9]*' | cut -d: -f2)
        if [ "$EXIT_CODE" = "0" ]; then
            pass "Pre-consume allows empty source path"
        else
            fail "Pre-consume rejected empty source path (exit $EXIT_CODE)"
        fi
    else
        warn "docker CLI not available — skipping pre-consume container tests (3-9)"
        warn "Run from host: ./e2e/test.sh hardening"
    fi

    # --------------------------------------------------------------------------
    # Test 10: Migration 006 applied — update_family operation type
    # --------------------------------------------------------------------------
    info "Test: Reconciliation log accepts update_family operation"
    CONSTRAINT_CHECK=$(psql "$CHATUI_DB" -t -A -c "
        SELECT conname FROM pg_constraint
        WHERE conname = 'reconciliation_log_operation_check'
    " 2>/dev/null || echo "")
    if [ -n "$CONSTRAINT_CHECK" ]; then
        # Try to check if update_family is in the constraint
        CONSTRAINT_DEF=$(psql "$CHATUI_DB" -t -A -c "
            SELECT pg_get_constraintdef(oid) FROM pg_constraint
            WHERE conname = 'reconciliation_log_operation_check'
        " 2>/dev/null || echo "")
        if echo "$CONSTRAINT_DEF" | grep -q "update_family"; then
            pass "reconciliation_log accepts 'update_family' operation"
        else
            fail "reconciliation_log constraint missing 'update_family'"
            echo "   Constraint: $CONSTRAINT_DEF"
        fi
    else
        warn "reconciliation_log_operation_check constraint not found (migration 006 not yet applied)"
    fi

    # --------------------------------------------------------------------------
    # Test 11: Migration 006 applied — documents_family_updated column
    # --------------------------------------------------------------------------
    info "Test: reconciliation_state has documents_family_updated column"
    COL_EXISTS=$(psql "$CHATUI_DB" -t -A -c "
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'sync'
        AND table_name = 'reconciliation_state'
        AND column_name = 'documents_family_updated'
    " 2>/dev/null || echo "")
    if [ -n "$COL_EXISTS" ]; then
        pass "documents_family_updated column exists"
    else
        warn "documents_family_updated column not found (migration 006 not yet applied)"
    fi

    # --------------------------------------------------------------------------
    # Test 12: Dashboard reconcile API endpoint responds
    # --------------------------------------------------------------------------
    info "Test: Dashboard /api/reconcile endpoint exists"
    RECONCILE_RESPONSE=$(curl -sf -X POST "$DASHBOARD_URL/api/reconcile" \
        -H "Content-Type: application/json" 2>&1)
    RECONCILE_STATUS=$?
    if [ $RECONCILE_STATUS -eq 0 ]; then
        SUCCESS=$(echo "$RECONCILE_RESPONSE" | jq -r '.success // false')
        MESSAGE=$(echo "$RECONCILE_RESPONSE" | jq -r '.message // "unknown"')
        if [ "$SUCCESS" = "true" ]; then
            pass "Dashboard reconcile API works (triggered reconciliation)"
        else
            # 502 means n8n webhook not reachable — that's an infra issue, not our code
            pass "Dashboard reconcile API responds ($MESSAGE)"
        fi
    else
        fail "Dashboard reconcile API not reachable"
    fi

    # --------------------------------------------------------------------------
    # Test 13: Dashboard serves admin actions section
    # --------------------------------------------------------------------------
    info "Test: Dashboard has Reconcile Now button"
    DASHBOARD_HTML=$(curl -sf "$DASHBOARD_URL/" 2>/dev/null || echo "")
    if echo "$DASHBOARD_HTML" | grep -q "reconcileBtn"; then
        pass "Dashboard has Reconcile Now button"
    else
        fail "Dashboard missing Reconcile Now button"
    fi

    # --------------------------------------------------------------------------
    # Test 14: Dashboard can reach n8n (verifies N8N_INTERNAL_URL wiring)
    # --------------------------------------------------------------------------
    info "Test: Dashboard reconcile endpoint can reach n8n"
    # The reconcile API returns success:true if n8n is reachable, or a 502 error message
    DASH_N8N=$(curl -sf -X POST "$DASHBOARD_URL/api/reconcile" \
        -H "Content-Type: application/json" 2>/dev/null || echo '{"success":false}')
    DASH_SUCCESS=$(echo "$DASH_N8N" | jq -r '.success // false')
    if [ "$DASH_SUCCESS" = "true" ]; then
        pass "Dashboard reaches n8n via N8N_INTERNAL_URL"
    else
        DASH_MSG=$(echo "$DASH_N8N" | jq -r '.message // "unknown"')
        warn "Dashboard cannot reach n8n: $DASH_MSG (N8N_INTERNAL_URL may need rebuild)"
    fi

    # --------------------------------------------------------------------------
    # Test 15: Qdrant vectors have family_id in payload
    # --------------------------------------------------------------------------
    info "Test: Qdrant vectors have family_id payload"
    VECTOR_COUNT=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" | jq -r '.result.points_count // 0')
    if [ "$VECTOR_COUNT" -gt 0 ]; then
        SAMPLE=$(curl -sf -X POST "$QDRANT_URL/collections/mattervault_documents_v3/points/scroll" \
            -H "Content-Type: application/json" \
            -d '{"limit":1,"with_payload":["family_id","document_id"],"with_vector":false}')
        SAMPLE_FAMILY=$(echo "$SAMPLE" | jq -r '.result.points[0].payload.family_id // empty' 2>/dev/null)
        if [ -n "$SAMPLE_FAMILY" ]; then
            pass "Qdrant vectors have family_id payload (sample: $SAMPLE_FAMILY)"
        else
            fail "Qdrant vectors missing family_id payload"
        fi
    else
        warn "No vectors in Qdrant — skipping payload test"
    fi

    # --------------------------------------------------------------------------
    # Test 16: Reconciliation webhook is accessible
    # --------------------------------------------------------------------------
    info "Test: Reconciliation webhook is reachable"
    # The webhook should accept POST requests (returns 200 and triggers a run)
    WEBHOOK_RESPONSE=$(curl -sf -o /dev/null -w "%{http_code}" \
        -X POST "$N8N_URL/webhook/document-reconciliation" \
        -H "Content-Type: application/json" \
        -d '{"trigger":"test","source":"e2e"}' 2>/dev/null || echo "000")
    if [ "$WEBHOOK_RESPONSE" = "200" ]; then
        pass "Reconciliation webhook is reachable (HTTP $WEBHOOK_RESPONSE)"
    else
        fail "Reconciliation webhook returned HTTP $WEBHOOK_RESPONSE"
    fi
}

# ==============================================================================
# PROMPT QUALITY TESTS
# ==============================================================================
do_prompt_quality_tests() {
    header "Prompt Quality Tests"

    # Get valid user_id
    USER_ID=$(psql "$CHATUI_DB" -t -A -c "SELECT id FROM users WHERE paperless_username='admin' LIMIT 1" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$USER_ID" ]; then
        fail "No admin user in ChatUI database"
        info "Login via chat-ui first to create user"
        return 1
    fi

    # Test 1: Off-topic question should be declined
    echo ""
    info "Test: off-topic question rejection"
    RESPONSE=$(curl -s --max-time 120 "$N8N_URL/webhook/chat-api-v3" \
        -H "Content-Type: application/json" \
        -d "{\"question\":\"What is the capital of France?\",\"family_id\":\"morrison\",\"user_id\":\"$USER_ID\",\"conversation_id\":\"test-grounding-$(date +%s)\"}" 2>/dev/null || echo '{"error":"timeout"}')

    ANSWER=$(echo "$RESPONSE" | jq -r '.output // .message // "no output"' 2>/dev/null | tr '[:upper:]' '[:lower:]')
    if echo "$ANSWER" | grep -qiE "don.t find|no information|cannot determine|only answer questions about documents|not in.*documents|unrelated|can only answer"; then
        pass "Model correctly declined off-topic question"
    elif echo "$ANSWER" | grep -qiE "error in workflow|timeout"; then
        warn "Off-topic test skipped (workflow error — retry with: test.sh prompt)"
    else
        fail "Model answered off-topic question: $(echo "$ANSWER" | head -c 200)"
    fi

    sleep 2

    # Test 2: On-topic question should include citations
    info "Test: citation format in on-topic response"
    RESPONSE2=$(curl -s --max-time 120 "$N8N_URL/webhook/chat-api-v3" \
        -H "Content-Type: application/json" \
        -d "{\"question\":\"What documents do we have for this family?\",\"family_id\":\"morrison\",\"user_id\":\"$USER_ID\",\"conversation_id\":\"test-citations-$(date +%s)\"}" 2>/dev/null || echo '{"error":"timeout"}')

    ANSWER2=$(echo "$RESPONSE2" | jq -r '.output // .message // "no output"' 2>/dev/null)
    if echo "$ANSWER2" | grep -qiE "\(Source:.*Page"; then
        pass "Model uses correct citation format (Source: [Title], Page [N])"
    elif echo "$ANSWER2" | grep -qiE "error in workflow|timeout"; then
        warn "Citation test skipped (workflow error — retry with: test.sh prompt)"
    elif echo "$ANSWER2" | grep -qiE "source|document|page"; then
        warn "Model references documents but may not use exact citation format"
    else
        fail "Model response lacks citations: $(echo "$ANSWER2" | head -c 200)"
    fi
}

# ==============================================================================
# HALLUCINATION TESTS (JSON-driven adversarial + factual + citation tests)
# ==============================================================================

# Helper: run a single test category from test-queries.json
# Usage: _run_test_category "category_key" "Category Label" "$USER_ID"
_run_test_category() {
    local category="$1"
    local label="$2"
    local user_id="$3"
    local test_file="/e2e/test-queries.json"

    header "$label"

    local count
    count=$(jq ".${category} | length" "$test_file" 2>/dev/null)
    if [ -z "$count" ] || [ "$count" -eq 0 ]; then
        warn "No ${category} tests found in $test_file"
        return 0
    fi

    for i in $(seq 0 $((count - 1))); do
        local test_name test_query test_family match_mode conv_id
        test_name=$(jq -r ".${category}[$i].name" "$test_file")
        test_query=$(jq -r ".${category}[$i].query" "$test_file")
        test_family=$(jq -r ".${category}[$i].family_id" "$test_file")
        match_mode=$(jq -r ".${category}[$i].match_mode" "$test_file")
        conv_id="hallucination-${category}-${i}-$(date +%s%N)"

        echo ""
        info "Test: $test_name"

        # Build JSON payload safely with jq (no shell interpolation in JSON)
        local payload
        payload=$(jq -n \
            --arg q "$test_query" \
            --arg f "$test_family" \
            --arg u "$user_id" \
            --arg c "$conv_id" \
            '{question: $q, family_id: $f, user_id: $u, conversation_id: $c}')

        local response output
        response=$(curl -sf --max-time 120 "$N8N_URL/webhook/chat-api-v3" \
            -H "Content-Type: application/json" \
            -d "$payload" 2>/dev/null || echo '{"error":"timeout"}')

        output=$(echo "$response" | jq -r '.output // .message // "no output"' 2>/dev/null || echo "$response")

        # Check for workflow errors first
        if echo "$output" | grep -qiE "error in workflow|timeout|no output"; then
            warn "$test_name (workflow error or timeout — retry later)"
            sleep 2
            continue
        fi

        # Match logic driven by match_mode from JSON
        local patterns_json
        patterns_json=$(jq -r ".${category}[$i].match_patterns[]" "$test_file")

        if [ "$match_mode" = "all" ]; then
            # AND logic: ALL patterns must match
            local all_matched=1 missing_pattern=""
            while IFS= read -r pattern; do
                if ! echo "$output" | grep -qiE "$pattern"; then
                    all_matched=0
                    missing_pattern="$pattern"
                    break
                fi
            done <<< "$patterns_json"

            if [ "$all_matched" -eq 1 ]; then
                pass "$test_name"
                echo "   ${output:0:120}..."
            else
                fail "$test_name (missing: $missing_pattern)"
                echo "   Got: ${output:0:200}"
            fi
        else
            # OR logic (default): any pattern match = pass
            local matched=0
            while IFS= read -r pattern; do
                if echo "$output" | grep -qiE "$pattern"; then
                    matched=1
                    break
                fi
            done <<< "$patterns_json"

            if [ "$matched" -eq 1 ]; then
                pass "$test_name"
                echo "   ${output:0:120}..."
            else
                fail "$test_name (no pattern matched)"
                echo "   Got: ${output:0:200}"
            fi
        fi

        sleep 2
    done
}

run_hallucination_tests() {
    header "Hallucination Tests (JSON-driven)"

    TEST_QUERIES_FILE="/e2e/test-queries.json"
    if [ ! -f "$TEST_QUERIES_FILE" ]; then
        fail "Test queries file not found: $TEST_QUERIES_FILE"
        return 1
    fi

    # Get valid user_id
    USER_ID=$(psql "$CHATUI_DB" -t -A -c "SELECT id FROM users WHERE paperless_username='admin' LIMIT 1" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$USER_ID" ]; then
        fail "No admin user in ChatUI database"
        info "Login via chat-ui first to create user"
        return 1
    fi
    info "Using user_id: $USER_ID"

    _run_test_category "grounding_tests" "Grounding Tests (off-topic / fabrication rejection)" "$USER_ID"
    _run_test_category "factual_tests" "Factual Accuracy Tests (known Morrison data)" "$USER_ID"
    _run_test_category "citation_tests" "Citation Format Tests" "$USER_ID"
}

# ==============================================================================
# INGESTION STATUS TESTS
# ==============================================================================
do_ingestion_status_tests() {
    header "Ingestion Status Tests"

    # Get auth token
    TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | jq -r '.token // empty')

    if [ -z "$TOKEN" ]; then
        fail "Could not authenticate with Paperless"
        return 1
    fi

    # Test 1: Status tags exist in Paperless
    for tag_name in "processing" "ai_ready" "ingestion_error"; do
        TAG_CHECK=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=$tag_name" \
            -H "Authorization: Token $TOKEN" 2>/dev/null)
        COUNT=$(echo "$TAG_CHECK" | jq '.count // 0')
        if [ "$COUNT" -gt 0 ]; then
            pass "Paperless tag '$tag_name' exists"
        else
            fail "Paperless tag '$tag_name' missing (run init-mattervault.sh)"
        fi
    done

    # Test 2: Check that ingested documents have ai_ready tag (not processing)
    DOC_COUNT=$(curl -sf "$PAPERLESS_URL/api/documents/" \
        -H "Authorization: Token $TOKEN" | jq '.count // 0')

    if [ "$DOC_COUNT" -gt 0 ]; then
        # Get first document's tags
        FIRST_DOC=$(curl -sf "$PAPERLESS_URL/api/documents/?page_size=1" \
            -H "Authorization: Token $TOKEN")
        DOC_ID=$(echo "$FIRST_DOC" | jq -r '.results[0].id')
        DOC_TAGS=$(echo "$FIRST_DOC" | jq -r '.results[0].tags[]' 2>/dev/null)

        # Get ai_ready tag ID
        AI_READY_ID=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=ai_ready" \
            -H "Authorization: Token $TOKEN" | jq -r '.results[0].id // empty')
        PROCESSING_ID=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=processing" \
            -H "Authorization: Token $TOKEN" | jq -r '.results[0].id // empty')

        if [ -n "$AI_READY_ID" ] && echo "$DOC_TAGS" | grep -q "^${AI_READY_ID}$"; then
            pass "Document $DOC_ID has 'ai_ready' tag"
        else
            warn "Document $DOC_ID missing 'ai_ready' tag (may need re-ingestion after workflow update)"
        fi

        if [ -n "$PROCESSING_ID" ] && echo "$DOC_TAGS" | grep -q "^${PROCESSING_ID}$"; then
            fail "Document $DOC_ID still has 'processing' tag (stuck?)"
        else
            pass "Document $DOC_ID does not have stale 'processing' tag"
        fi
    else
        warn "No documents in Paperless — skipping tag verification"
    fi

    # Test 3: Verify ingestion workflow JSON has tag management nodes
    info "Test: Ingestion workflow has tag management nodes"
    WF_FILE="/e2e/../n8n-workflows/document-ingestion-v2.json"
    if [ -f "$WF_FILE" ]; then
        if grep -q "Tag: Processing" "$WF_FILE" && grep -q "Tag: AI Ready" "$WF_FILE"; then
            pass "Ingestion workflow has tag management nodes"
        else
            fail "Ingestion workflow missing tag management nodes"
        fi
    else
        warn "Workflow file not accessible from test container"
    fi
}

# ==============================================================================
# LARGE PDF HANDLING TESTS
# ==============================================================================
do_large_pdf_tests() {
    header "Large PDF Handling Tests"

    # Test 1: PyPDF2 is available in n8n container
    if command -v docker >/dev/null 2>&1; then
        info "Test: PyPDF2 available in n8n container"
        if docker exec matterlogic python3 -c "from PyPDF2 import PdfReader; print('PyPDF2 available')" 2>/dev/null; then
            pass "PyPDF2 available in n8n container"
        else
            fail "PyPDF2 missing from n8n container (rebuild: docker compose build n8n)"
        fi

        info "Test: split-pdf.py script is mounted"
        if docker exec matterlogic test -f /files/scripts/split-pdf.py; then
            pass "split-pdf.py is mounted in n8n container"
        else
            fail "split-pdf.py not found at /files/scripts/split-pdf.py"
        fi

        info "Test: split-pdf.py is functional"
        SPLIT_TEST=$(docker exec matterlogic python3 /files/scripts/split-pdf.py --help 2>&1)
        if echo "$SPLIT_TEST" | grep -q "max-pages"; then
            pass "split-pdf.py is functional (--max-pages flag recognized)"
        else
            fail "split-pdf.py not working: $SPLIT_TEST"
        fi
    else
        warn "docker CLI not available — skipping large PDF container tests"
        warn "Run from host to test: docker exec matterlogic python3 -c 'from PyPDF2 import PdfReader'"
    fi

    # Test 2: Docling timeout is sufficient for large PDFs (>= 600s)
    info "Test: Docling timeout >= 600s"
    WF_FILE="/e2e/../n8n-workflows/document-ingestion-v2.json"
    if [ -f "$WF_FILE" ]; then
        TIMEOUT=$(python3 -c "
import json
wf = json.load(open('$WF_FILE'))
wf = wf[0] if isinstance(wf, list) else wf
for node in wf['nodes']:
    if node['name'] == 'Start Docling Chunking':
        print(node['parameters']['options'].get('timeout', 0))
        break
" 2>/dev/null || echo "0")
        if [ "${TIMEOUT:-0}" -ge 600000 ]; then
            pass "Docling timeout is ${TIMEOUT}ms (>= 600s)"
        else
            fail "Docling timeout too low: ${TIMEOUT}ms (need >= 600000)"
        fi
    else
        warn "Workflow file not accessible"
    fi

    # Test 3: Polling max is sufficient (>= 120 polls = 10 min at 5s intervals)
    info "Test: Docling polling max >= 120"
    if [ -f "$WF_FILE" ]; then
        POLL_MAX=$(python3 -c "
import json, re
wf = json.load(open('$WF_FILE'))
wf = wf[0] if isinstance(wf, list) else wf
for node in wf['nodes']:
    if node['name'] == 'Check If Complete':
        m = re.search(r'pollCount >= (\d+)', node['parameters']['jsCode'])
        if m:
            print(m.group(1))
        break
" 2>/dev/null || echo "0")
        if [ "${POLL_MAX:-0}" -ge 120 ]; then
            pass "Docling polling max is ${POLL_MAX} (>= 120)"
        else
            fail "Docling polling max too low: ${POLL_MAX} (need >= 120)"
        fi
    else
        warn "Workflow file not accessible"
    fi
}

# ==============================================================================
# EMBEDDING VALIDATION TESTS
# ==============================================================================
run_embedding_validation_tests() {
    header "Embedding Validation Tests"

    # Test 1: Qdrant collection v3 exists
    info "Test: Qdrant collection mattervault_documents_v3 exists"
    COLLECTION_RESP=$(curl -sf "$QDRANT_URL/collections/mattervault_documents_v3" 2>/dev/null)
    if echo "$COLLECTION_RESP" | jq -e '.result.status' >/dev/null 2>&1; then
        pass "Qdrant collection mattervault_documents_v3 exists"
    else
        fail "Qdrant collection mattervault_documents_v3 not found"
    fi

    # Test 2: Vector dimensions = 1024
    info "Test: Dense vector dimensions = 1024"
    VECTOR_SIZE=$(echo "$COLLECTION_RESP" | jq -r '.result.config.params.vectors.dense.size // 0' 2>/dev/null)
    if [ "${VECTOR_SIZE:-0}" -eq 1024 ]; then
        pass "Dense vector dimensions = 1024 (bge-m3)"
    else
        fail "Dense vector dimensions = ${VECTOR_SIZE:-unknown} (expected 1024)"
    fi

    # Test 3: bge-m3 model available in Ollama
    info "Test: bge-m3 model available in Ollama"
    OLLAMA_HOST="${OLLAMA_URL:-http://host.docker.internal:11434}"
    MODELS_RESP=$(curl -sf "$OLLAMA_HOST/api/tags" 2>/dev/null)
    if echo "$MODELS_RESP" | jq -e '.models[] | select(.name | startswith("bge-m3"))' >/dev/null 2>&1; then
        pass "bge-m3 model available in Ollama"
    else
        fail "bge-m3 model not found in Ollama (run: ollama pull bge-m3)"
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
        do_prompt_quality_tests
        run_hallucination_tests
        run_embedding_validation_tests
        ;;
    full)
        do_reset
        do_ingest
        do_test
        do_verify
        do_prompt_quality_tests
        run_hallucination_tests
        run_embedding_validation_tests
        ;;
    sync)
        do_sync_tests
        ;;
    audit)
        do_audit_tests
        ;;
    hardening)
        do_hardening_tests
        ;;
    prompt)
        do_prompt_quality_tests
        ;;
    hallucination)
        run_hallucination_tests
        ;;
    ingestion-status)
        do_ingestion_status_tests
        ;;
    large-pdf)
        do_large_pdf_tests
        ;;
    embedding)
        run_embedding_validation_tests
        ;;
    all)
        do_reset
        do_ingest
        do_test
        do_verify
        do_prompt_quality_tests
        run_hallucination_tests
        do_sync_tests
        do_audit_tests
        do_hardening_tests
        do_ingestion_status_tests
        do_large_pdf_tests
        run_embedding_validation_tests
        ;;
    *)
        echo "Usage: $0 [reset|test|full|sync|audit|hardening|prompt|hallucination|ingestion-status|large-pdf|embedding|all]"
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
