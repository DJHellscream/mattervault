#!/bin/bash
# ==============================================================================
# Mattervault End-to-End Reset Script
# Clears ALL data from all systems for a fresh start
#
# WARNING: This script DELETES ALL DATA. Use only for testing!
#
# Usage: ./scripts/e2e-reset.sh [--confirm]
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Safety check
if [[ "${1:-}" != "--confirm" ]]; then
    echo -e "${RED}WARNING: This script will DELETE ALL DATA from:${NC}"
    echo "  - Paperless-ngx (all documents)"
    echo "  - Qdrant (all vectors)"
    echo "  - Chat-UI database (users, conversations, messages, audit logs)"
    echo ""
    echo "Run with --confirm to proceed:"
    echo "  ./scripts/e2e-reset.sh --confirm"
    exit 1
fi

echo "=========================================="
echo "  Mattervault E2E Reset"
echo "=========================================="
echo ""

# Load environment
PAPERLESS_PASS="${PAPERLESS_ADMIN_PASS:-mattervault2025}"
if [[ -f "$PROJECT_DIR/.env" ]]; then
    PAPERLESS_PASS=$(grep -E '^PAPERLESS_ADMIN_PASS=' "$PROJECT_DIR/.env" | cut -d= -f2 | tr -d '[:space:]' | cut -d'#' -f1 || echo "mattervault2025")
fi

# ============================================
# Step 1: Clear Paperless-ngx
# ============================================
echo -e "${YELLOW}[1/5] Clearing Paperless-ngx...${NC}"

# Get auth token
TOKEN=$(docker exec matterlogic wget -q -O - \
    --header="Content-Type: application/json" \
    --post-data="{\"username\":\"admin\",\"password\":\"$PAPERLESS_PASS\"}" \
    "http://mattervault:8000/api/token/" 2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || echo "")

if [[ -n "$TOKEN" ]]; then
    # Get all document IDs
    DOC_IDS=$(docker exec matterlogic wget -q -O - \
        --header="Authorization: Token $TOKEN" \
        "http://mattervault:8000/api/documents/" 2>/dev/null | grep -o '"id":[0-9]*' | cut -d: -f2 || true)

    if [[ -n "$DOC_IDS" ]]; then
        DOC_COUNT=$(echo "$DOC_IDS" | wc -w)
        echo "  Deleting $DOC_COUNT document(s)..."

        for doc_id in $DOC_IDS; do
            docker exec matterlogic node -e "
const http = require('http');
const req = http.request({
  hostname: 'mattervault', port: 8000,
  path: '/api/documents/$doc_id/',
  method: 'DELETE',
  headers: { 'Authorization': 'Token $TOKEN' }
}, res => { process.exit(res.statusCode < 300 ? 0 : 1); });
req.end();
" 2>/dev/null || true
        done
    fi

    # Empty trash via database
    docker exec matterdb-paperless psql -U paperless -d paperless -c "
        DELETE FROM documents_document_tags WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
        DELETE FROM documents_note WHERE document_id IN (SELECT id FROM documents_document WHERE deleted_at IS NOT NULL);
        DELETE FROM documents_document WHERE deleted_at IS NOT NULL;
    " >/dev/null 2>&1 || true

    echo -e "  ${GREEN}✓ Paperless cleared${NC}"
else
    echo -e "  ${YELLOW}⚠ Could not authenticate with Paperless (may already be empty)${NC}"
fi

# ============================================
# Step 2: Clear Qdrant
# ============================================
echo -e "${YELLOW}[2/5] Clearing Qdrant...${NC}"

# Delete and recreate both collections
for collection in mattervault_documents mattervault_documents; do
    docker exec matterlogic node -e "
const http = require('http');
const req = http.request({
  hostname: 'mattermemory', port: 6333,
  path: '/collections/$collection',
  method: 'DELETE'
}, res => { process.exit(0); });
req.end();
" 2>/dev/null || true
done

# Recreate collection with hybrid schema
docker exec matterlogic node -e "
const http = require('http');
const data = JSON.stringify({
  vectors: { dense: { size: 1024, distance: 'Cosine' } },
  sparse_vectors: { bm25: { modifier: 'idf' } }
});
const req = http.request({
  hostname: 'mattermemory', port: 6333,
  path: '/collections/mattervault_documents',
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, res => { process.exit(res.statusCode < 300 ? 0 : 1); });
req.write(data);
req.end();
" 2>/dev/null || true

# Create indexes
for field in family_id document_id; do
    docker exec matterlogic node -e "
const http = require('http');
const data = JSON.stringify({ field_name: '$field', field_schema: 'keyword' });
const req = http.request({
  hostname: 'mattermemory', port: 6333,
  path: '/collections/mattervault_documents/index',
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, res => { process.exit(0); });
req.write(data);
req.end();
" 2>/dev/null || true
done

echo -e "  ${GREEN}✓ Qdrant cleared and recreated${NC}"

# ============================================
# Step 3: Clear Chat-UI Database
# ============================================
echo -e "${YELLOW}[3/5] Clearing Chat-UI database...${NC}"

docker exec matterdb-chatui psql -U chatui -d chatui -c "
    -- Clear audit logs (truncate partitions)
    DO \$\$
    DECLARE
        partition_name TEXT;
    BEGIN
        FOR partition_name IN
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'audit' AND tablename LIKE 'chat_query_logs_%'
        LOOP
            EXECUTE 'TRUNCATE TABLE audit.' || partition_name;
        END LOOP;
    END \$\$;

    -- Clear messages and conversations
    TRUNCATE TABLE messages CASCADE;
    TRUNCATE TABLE conversations CASCADE;

    -- Keep users table but clear sessions
    TRUNCATE TABLE sessions CASCADE;
" >/dev/null 2>&1

echo -e "  ${GREEN}✓ Chat-UI database cleared (users preserved)${NC}"

# ============================================
# Step 4: Clear intake folder
# ============================================
echo -e "${YELLOW}[4/5] Clearing intake folder...${NC}"

rm -rf "$PROJECT_DIR/intake/morrison"/* 2>/dev/null || true
rm -rf "$PROJECT_DIR/intake/johnson"/* 2>/dev/null || true
mkdir -p "$PROJECT_DIR/intake/morrison"
mkdir -p "$PROJECT_DIR/intake/johnson"

echo -e "  ${GREEN}✓ Intake folder cleared${NC}"

# ============================================
# Step 5: Verify clean state
# ============================================
echo -e "${YELLOW}[5/5] Verifying clean state...${NC}"

# Check Qdrant
VECTOR_COUNT=$(docker exec matterlogic wget -q -O - "http://mattermemory:6333/collections/mattervault_documents" 2>/dev/null | grep -o '"points_count":[0-9]*' | cut -d: -f2 || echo "0")
echo "  Qdrant vectors: $VECTOR_COUNT"

# Check conversations
CONV_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "SELECT COUNT(*) FROM conversations" 2>/dev/null || echo "0")
echo "  Conversations: $CONV_COUNT"

# Check audit logs
AUDIT_COUNT=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c "SELECT COUNT(*) FROM audit.chat_query_logs" 2>/dev/null || echo "0")
echo "  Audit logs: $AUDIT_COUNT"

echo ""
echo "=========================================="
echo -e "${GREEN}✓ E2E Reset Complete!${NC}"
echo ""
echo "System is ready for fresh testing."
echo "Next: Run ./scripts/e2e-test.sh to start the test"
echo "=========================================="
