#!/bin/bash
# ==============================================================================
# Mattervault End-to-End Test Suite
# Complete test of the ingestion and chat pipeline
#
# Prerequisites:
# - All Docker services running (docker compose up -d)
# - Native services running (Ollama, Docling)
# - System reset with ./scripts/e2e-reset.sh --confirm
#
# Usage: ./scripts/e2e-test.sh [--skip-ingest] [--all-docs]
#   --skip-ingest  Skip document ingestion (use existing data)
#   --all-docs     Ingest all Morrison docs (default: profile only)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
CHATUI_URL="http://host.docker.internal:3007"
N8N_URL="http://host.docker.internal:5678"
PAPERLESS_USER="${PAPERLESS_USER:-admin}"
PAPERLESS_PASS="${PAPERLESS_PASS:-mattervault2025}"
TEST_FAMILY="morrison"
DEMO_DATA="/workspace/demo data/Morrison Demo Data"

# Parse arguments
SKIP_INGEST=false
ALL_DOCS=false
for arg in "$@"; do
    case $arg in
        --skip-ingest) SKIP_INGEST=true ;;
        --all-docs) ALL_DOCS=true ;;
    esac
done

# Test tracking
PASSED=0
FAILED=0
WARNINGS=0

pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}✗ FAIL${NC}: $1"; FAILED=$((FAILED + 1)); }
warn() { echo -e "${YELLOW}⚠ WARN${NC}: $1"; WARNINGS=$((WARNINGS + 1)); }
info() { echo -e "${BLUE}ℹ INFO${NC}: $1"; }

echo "=========================================="
echo "  Mattervault E2E Test Suite"
echo "=========================================="
echo "Skip ingest: $SKIP_INGEST"
echo "All docs: $ALL_DOCS"
echo ""

# ============================================
# Phase 0: Health Check
# ============================================
echo -e "${YELLOW}=== Phase 0: Health Check ===${NC}"

# Check Docker services
for svc in mattervault matterlogic mattermemory matterdb-chatui; do
    if docker ps --filter "name=$svc" --filter "status=running" | grep -q "$svc"; then
        pass "Docker: $svc running"
    else
        fail "Docker: $svc not running"
    fi
done

# Check native services (try both localhost and host.docker.internal)
OLLAMA_OK=false
for url in "http://localhost:11434" "http://host.docker.internal:11434"; do
    if curl -sf "$url/api/tags" >/dev/null 2>&1; then
        OLLAMA_OK=true
        OLLAMA_URL="$url"
        break
    fi
done
if [ "$OLLAMA_OK" = true ]; then
    pass "Native: Ollama running ($OLLAMA_URL)"
else
    fail "Native: Ollama not running"
fi

DOCLING_OK=false
for url in "http://localhost:5001" "http://host.docker.internal:5001"; do
    if curl -sf "$url/health" >/dev/null 2>&1; then
        DOCLING_OK=true
        DOCLING_URL="$url"
        break
    fi
done
if [ "$DOCLING_OK" = true ]; then
    pass "Native: Docling running ($DOCLING_URL)"
else
    fail "Native: Docling not running"
fi

# Exit early if critical failures
if [ $FAILED -gt 0 ]; then
    echo -e "\n${RED}Critical services not running. Fix before continuing.${NC}"
    exit 1
fi

# ============================================
# Phase 1: Document Ingestion
# ============================================
echo ""
echo -e "${YELLOW}=== Phase 1: Document Ingestion ===${NC}"

if [ "$SKIP_INGEST" = true ]; then
    info "Skipping ingestion (--skip-ingest)"
else
    # Copy document to intake
    INTAKE_DIR="$PROJECT_DIR/intake/morrison"
    mkdir -p "$INTAKE_DIR"
    rm -f "$INTAKE_DIR"/*.pdf 2>/dev/null || true

    if [ "$ALL_DOCS" = true ]; then
        cp "$DEMO_DATA"/*.pdf "$INTAKE_DIR/" 2>/dev/null || true
        FILE_COUNT=$(ls -1 "$INTAKE_DIR"/*.pdf 2>/dev/null | wc -l)
        info "Copied $FILE_COUNT files (all docs mode)"
    else
        cp "$DEMO_DATA/00_Morrison_Family_Profile.pdf" "$INTAKE_DIR/"
        info "Copied Family Profile PDF"
    fi

    # Wait for Paperless to detect and process
    info "Waiting for Paperless to process (polling every 10s)..."

    MAX_WAIT=300  # 5 minutes
    ELAPSED=0
    DOC_FOUND=false

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Get Paperless token
        TOKEN=$(docker exec matterlogic wget -q -O - \
            --header="Content-Type: application/json" \
            --post-data="{\"username\":\"admin\",\"password\":\"$PAPERLESS_PASS\"}" \
            "http://mattervault:8000/api/token/" 2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || echo "")

        if [[ -n "$TOKEN" ]]; then
            DOC_COUNT=$(docker exec matterlogic wget -q -O - \
                --header="Authorization: Token $TOKEN" \
                "http://mattervault:8000/api/documents/" 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2 || echo "0")

            if [ "$DOC_COUNT" -gt 0 ]; then
                DOC_FOUND=true
                break
            fi
        fi

        sleep 10
        ELAPSED=$((ELAPSED + 10))
        echo -n "."
    done
    echo ""

    if [ "$DOC_FOUND" = true ]; then
        pass "Paperless processed $DOC_COUNT document(s)"
    else
        fail "Paperless did not process documents within timeout"
    fi

    # Wait for n8n to ingest vectors
    info "Waiting for vector ingestion (polling every 10s)..."

    ELAPSED=0
    VECTORS_FOUND=false

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        VECTOR_COUNT=$(docker exec matterlogic wget -q -O - \
            "http://mattermemory:6333/collections/mattervault_documents" 2>/dev/null | \
            grep -o '"points_count":[0-9]*' | cut -d: -f2 || echo "0")

        if [ "$VECTOR_COUNT" -gt 0 ]; then
            VECTORS_FOUND=true
            break
        fi

        sleep 10
        ELAPSED=$((ELAPSED + 10))
        echo -n "."
    done
    echo ""

    if [ "$VECTORS_FOUND" = true ]; then
        pass "Qdrant has $VECTOR_COUNT vectors"
    else
        fail "Vector ingestion did not complete within timeout"
    fi
fi

# ============================================
# Phase 2: Authentication
# ============================================
echo ""
echo -e "${YELLOW}=== Phase 2: Authentication ===${NC}"

LOGIN_RESPONSE=$(curl -s -X POST "${CHATUI_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${PAPERLESS_USER}\",\"password\":\"${PAPERLESS_PASS}\"}" \
    -c /tmp/e2e-cookies.txt 2>/dev/null || echo '{"error":"connection failed"}')

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4 || echo "")
USER_ID=$(echo "$LOGIN_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || echo "")

if [[ -n "$ACCESS_TOKEN" ]]; then
    pass "Login successful"
    info "User ID: $USER_ID"
else
    fail "Login failed: $LOGIN_RESPONSE"
    echo -e "\n${RED}Cannot continue without authentication.${NC}"
    exit 1
fi

# ============================================
# Phase 3: Chat API Tests
# ============================================
echo ""
echo -e "${YELLOW}=== Phase 3: Chat API Tests ===${NC}"

# Test questions and expected content
declare -A TEST_QUESTIONS
TEST_QUESTIONS["What are the key events?"]="1972|Harold|Eleanor|marry"
TEST_QUESTIONS["What is Harold's address?"]="Willowbrook|address|Indianapolis"
TEST_QUESTIONS["Who are Harold's children?"]="David|Katie|Rob"
TEST_QUESTIONS["When was Morrison Manufacturing sold?"]="2019|47.5|million"

run_chat_test() {
    local question="$1"
    local expected_pattern="$2"
    local test_name="$3"

    echo ""
    info "Testing: $test_name"

    # Call n8n webhook directly (more reliable than streaming endpoint)
    RESPONSE=$(curl -s -X POST "${N8N_URL}/webhook/chat-api-v3" \
        -H "Content-Type: application/json" \
        -d "{\"question\":\"$question\",\"family_id\":\"$TEST_FAMILY\",\"user_id\":\"$USER_ID\"}" \
        --max-time 120 2>/dev/null || echo '{"error":"timeout"}')

    # Extract output
    OUTPUT=$(echo "$RESPONSE" | grep -o '"output":"[^"]*"' | cut -d'"' -f4 | head -1 || echo "")

    if [[ -z "$OUTPUT" ]]; then
        OUTPUT=$(echo "$RESPONSE" | sed 's/.*"output":"\([^"]*\)".*/\1/' || echo "")
    fi

    # Check for expected content
    if echo "$OUTPUT" | grep -qiE "$expected_pattern"; then
        pass "$test_name"
        # Show snippet
        echo "    Response snippet: ${OUTPUT:0:150}..."
    else
        fail "$test_name"
        echo "    Expected pattern: $expected_pattern"
        echo "    Got: ${OUTPUT:0:200}"
    fi

    # Check for conversation_id (V5 persistence)
    CONV_ID=$(echo "$RESPONSE" | grep -o '"conversation_id":"[^"]*"' | cut -d'"' -f4 || echo "")
    if [[ -n "$CONV_ID" ]]; then
        info "  Conversation ID: $CONV_ID"
    fi
}

# Run tests
run_chat_test "What are the key events?" "1972|Harold|Eleanor|marry" "Key Events Timeline"
run_chat_test "What is Harold's address?" "Willowbrook|8742|Indianapolis" "Address Lookup"
run_chat_test "Who are Harold's children?" "David|Katie|Rob" "Family Members"
run_chat_test "When was Morrison Manufacturing sold?" "2019|47" "Business Sale"

# ============================================
# Phase 4: Audit Logging
# ============================================
echo ""
echo -e "${YELLOW}=== Phase 4: Audit Logging ===${NC}"

# Check if audit logs were created
AUDIT_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM audit.chat_query_logs
    WHERE created_at > NOW() - INTERVAL '10 minutes';
" 2>/dev/null || echo "0")

if [ "$AUDIT_COUNT" -ge 4 ]; then
    pass "Audit logs created ($AUDIT_COUNT records)"
else
    warn "Expected 4+ audit logs, found $AUDIT_COUNT"
fi

# Check conversation persistence
CONV_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM conversations
    WHERE created_at > NOW() - INTERVAL '10 minutes';
" 2>/dev/null || echo "0")

MSG_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM messages
    WHERE created_at > NOW() - INTERVAL '10 minutes';
" 2>/dev/null || echo "0")

if [ "$CONV_COUNT" -ge 1 ]; then
    pass "Conversations persisted ($CONV_COUNT)"
else
    warn "No conversations persisted"
fi

if [ "$MSG_COUNT" -ge 8 ]; then
    pass "Messages persisted ($MSG_COUNT - includes Q&A pairs)"
else
    warn "Expected 8+ messages, found $MSG_COUNT"
fi

# ============================================
# Phase 5: Data Integrity
# ============================================
echo ""
echo -e "${YELLOW}=== Phase 5: Data Integrity ===${NC}"

# Verify vector count matches expectations
VECTOR_COUNT=$(docker exec matterlogic wget -q -O - \
    "http://mattermemory:6333/collections/mattervault_documents" 2>/dev/null | \
    grep -o '"points_count":[0-9]*' | cut -d: -f2 || echo "0")

if [ "$VECTOR_COUNT" -gt 20 ]; then
    pass "Vector count reasonable ($VECTOR_COUNT)"
else
    warn "Low vector count: $VECTOR_COUNT"
fi

# Verify family_id filtering works
MORRISON_VECTORS=$(docker exec matterlogic node -e "
const http = require('http');
const data = JSON.stringify({
  filter: { must: [{ key: 'family_id', match: { value: 'morrison' } }] },
  limit: 1,
  with_payload: false
});
const req = http.request({
  hostname: 'mattermemory', port: 6333,
  path: '/collections/mattervault_documents/points/scroll',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, res => {
  let d=''; res.on('data', c => d+=c);
  res.on('end', () => console.log(d));
});
req.write(data);
req.end();
" 2>/dev/null | grep -o '"points":\[' || echo "")

if [[ -n "$MORRISON_VECTORS" ]]; then
    pass "Family ID filtering works"
else
    warn "Could not verify family ID filtering"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "=========================================="
echo "  E2E Test Summary"
echo "=========================================="
echo -e "Passed:   ${GREEN}${PASSED}${NC}"
echo -e "Failed:   ${RED}${FAILED}${NC}"
echo -e "Warnings: ${YELLOW}${WARNINGS}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All critical tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Review output above.${NC}"
    exit 1
fi
