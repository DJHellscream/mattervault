#!/bin/bash
# Test Audit Logging System
# Verifies the audit logging infrastructure is working correctly
#
# Prerequisites:
# - Chat-UI service running (docker compose up)
# - Database migrations applied
# - Valid Paperless credentials

set -euo pipefail

# Configuration
CHATUI_URL="${CHATUI_URL:-http://localhost:3007}"
PAPERLESS_USER="${PAPERLESS_USER:-admin}"
PAPERLESS_PASS="${PAPERLESS_PASS:-mattervault2025}"
TEST_FAMILY="${TEST_FAMILY:-morrison}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=== Audit Logging Test Suite ==="
echo "Chat-UI URL: ${CHATUI_URL}"
echo ""

# Track test results
PASSED=0
FAILED=0

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    FAILED=$((FAILED + 1))
}

warn() {
    echo -e "${YELLOW}⚠ WARN${NC}: $1"
}

# ============================================
# Test 1: Check if audit schema exists
# ============================================
echo ""
echo "--- Test 1: Database Schema ---"

# Check if we can connect to the database via docker
if docker exec matterdb-chatui psql -U chatui -d chatui -c "SELECT 1 FROM audit.chat_query_logs LIMIT 0" 2>/dev/null; then
    pass "Audit schema and table exist"
else
    fail "Audit schema or table missing - run migrations"
fi

# Check immutability trigger
trigger_exists=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM pg_trigger
    WHERE tgname = 'audit_immutable_trigger';
" 2>/dev/null || echo "0")

if [ "$trigger_exists" -ge 1 ]; then
    pass "Immutability trigger exists"
else
    fail "Immutability trigger missing"
fi

# ============================================
# Test 2: Login and get token
# ============================================
echo ""
echo "--- Test 2: Authentication ---"

LOGIN_RESPONSE=$(curl -s -X POST "${CHATUI_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${PAPERLESS_USER}\",\"password\":\"${PAPERLESS_PASS}\"}" \
    -c /tmp/cookies.txt)

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.accessToken // empty')

if [ -n "$ACCESS_TOKEN" ]; then
    pass "Login successful, got access token"
else
    fail "Login failed: $LOGIN_RESPONSE"
    echo "Skipping remaining tests that require authentication"
    exit 1
fi

# ============================================
# Test 3: Make a chat query (generates audit log)
# ============================================
echo ""
echo "--- Test 3: Chat Query (Generates Audit Log) ---"

# Generate a unique test identifier
TEST_ID="audit-test-$(date +%s)"

# Make a chat query
echo "Sending test query with marker: ${TEST_ID}"
CHAT_RESPONSE=$(curl -s -X GET "${CHATUI_URL}/api/chat/stream?question=Test+query+${TEST_ID}&family_id=${TEST_FAMILY}" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Accept: text/event-stream" \
    --max-time 60 || true)

# Give it a moment to write to the database
sleep 2

# Check if audit log was created
AUDIT_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM audit.chat_query_logs
    WHERE query_text LIKE '%${TEST_ID}%'
    AND created_at > NOW() - INTERVAL '5 minutes';
" 2>/dev/null || echo "0")

if [ "$AUDIT_COUNT" -ge 1 ]; then
    pass "Audit log created for chat query"

    # Show the audit record
    echo "  Audit record details:"
    docker exec matterdb-chatui psql -U chatui -d chatui -c "
        SELECT
            correlation_id,
            paperless_username,
            family_id,
            LEFT(query_text, 50) as query_preview,
            total_latency_ms,
            created_at
        FROM audit.chat_query_logs
        WHERE query_text LIKE '%${TEST_ID}%'
        ORDER BY created_at DESC
        LIMIT 1;
    " 2>/dev/null
else
    fail "No audit log found for test query"
    warn "Chat response was: ${CHAT_RESPONSE:0:200}..."
fi

# ============================================
# Test 4: Verify immutability (UPDATE should fail)
# ============================================
echo ""
echo "--- Test 4: Immutability Check ---"

UPDATE_RESULT=$(docker exec matterdb-chatui psql -U chatui -d chatui -c "
    UPDATE audit.chat_query_logs
    SET query_text = 'TAMPERED'
    WHERE query_text LIKE '%${TEST_ID}%';
" 2>&1 || true)

if echo "$UPDATE_RESULT" | grep -q "immutable\|not permitted"; then
    pass "UPDATE correctly blocked by immutability trigger"
else
    fail "UPDATE was not blocked - immutability broken!"
    echo "  Result: $UPDATE_RESULT"
fi

# ============================================
# Test 5: Admin API - Summary endpoint
# ============================================
echo ""
echo "--- Test 5: Admin Summary API ---"

# First check if user is admin
USER_ROLE=$(echo "$LOGIN_RESPONSE" | jq -r '.user.role // "user"')

if [ "$USER_ROLE" = "admin" ]; then
    SUMMARY_RESPONSE=$(curl -s -X GET "${CHATUI_URL}/api/audit/summary?group_by=month" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")

    if echo "$SUMMARY_RESPONSE" | jq -e '.summary' > /dev/null 2>&1; then
        pass "Admin summary API working"
        echo "  Summary: $(echo "$SUMMARY_RESPONSE" | jq -c '.summary')"
    else
        fail "Admin summary API returned unexpected response"
        echo "  Response: $SUMMARY_RESPONSE"
    fi
else
    warn "User is not admin, skipping admin API test"
fi

# ============================================
# Test 6: Partition check
# ============================================
echo ""
echo "--- Test 6: Partition Structure ---"

PARTITION_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM pg_tables
    WHERE schemaname = 'audit'
    AND tablename LIKE 'chat_query_logs_%'
    AND tablename != 'chat_query_logs';
" 2>/dev/null || echo "0")

if [ "$PARTITION_COUNT" -ge 12 ]; then
    pass "Found ${PARTITION_COUNT} partitions (expected 24)"
else
    warn "Only ${PARTITION_COUNT} partitions found (expected 24)"
fi

# List current month's partition
CURRENT_PARTITION="chat_query_logs_$(date +%Y_%m)"
PARTITION_EXISTS=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "
    SELECT COUNT(*) FROM pg_tables
    WHERE schemaname = 'audit'
    AND tablename = '${CURRENT_PARTITION}';
" 2>/dev/null || echo "0")

if [ "$PARTITION_EXISTS" -eq 1 ]; then
    pass "Current month partition exists: audit.${CURRENT_PARTITION}"
else
    fail "Current month partition missing: audit.${CURRENT_PARTITION}"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}${PASSED}${NC}"
echo -e "Failed: ${RED}${FAILED}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed. Review output above.${NC}"
    exit 1
fi
