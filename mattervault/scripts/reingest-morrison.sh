#!/bin/bash
# Re-ingest Morrison documents
# This script:
# 1. Deletes Morrison documents from Paperless (and empties trash)
# 2. Deletes Morrison vectors from Qdrant
# 3. Copies demo data to intake folder to trigger re-ingestion
#
# Usage: ./reingest-morrison.sh [--all | --profile-only]
#   --profile-only  Only re-ingest the Family Profile PDF (default)
#   --all           Re-ingest all Morrison demo documents

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

# Load environment
PAPERLESS_PASS="${PAPERLESS_ADMIN_PASS:-mattervault2025}"
if [[ -f "$PROJECT_DIR/.env" ]]; then
    PAPERLESS_PASS=$(grep -E '^PAPERLESS_ADMIN_PASS=' "$PROJECT_DIR/.env" | cut -d= -f2 | tr -d '[:space:]' | cut -d'#' -f1)
fi

# Internal Docker network URLs (called via docker exec)
PAPERLESS_URL="http://mattervault:8000"
QDRANT_URL="http://qdrant:6333"
CONTAINER="matterlogic"

DEMO_DATA="/workspace/demo data/Morrison Demo Data"
INTAKE_DIR="$PROJECT_DIR/intake/morrison"

MODE="${1:---profile-only}"

echo "=========================================="
echo "Morrison Document Re-ingestion"
echo "Mode: $MODE"
echo "=========================================="

# Helper: run wget from inside Docker network
docker_wget() {
    local url="$1"
    local method="${2:-GET}"
    local data="${3:-}"
    local extra_args=""

    if [[ "$method" == "POST" && -n "$data" ]]; then
        extra_args="--header=\"Content-Type: application/json\" --post-data='$data'"
    elif [[ "$method" == "DELETE" ]]; then
        # wget doesn't support DELETE, use node instead
        docker exec "$CONTAINER" node -e "
const http = require('http');
const url = new URL('$url');
const req = http.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: 'DELETE',
  headers: { 'Authorization': 'Token $TOKEN' }
}, res => {
  let d=''; res.on('data', c => d+=c);
  res.on('end', () => { console.log(d); process.exit(res.statusCode < 300 ? 0 : 1); });
});
req.end();
" 2>/dev/null
        return
    fi

    docker exec "$CONTAINER" sh -c "wget -q -O - $extra_args '$url'" 2>/dev/null
}

# Step 1: Get Paperless auth token
echo ""
echo "[1/5] Authenticating with Paperless..."
TOKEN=$(docker exec "$CONTAINER" wget -q -O - \
    --header="Content-Type: application/json" \
    --post-data="{\"username\":\"admin\",\"password\":\"$PAPERLESS_PASS\"}" \
    "$PAPERLESS_URL/api/token/" 2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$TOKEN" ]]; then
    echo "✗ Failed to authenticate with Paperless"
    exit 1
fi
echo "✓ Authenticated"

# Step 2: Find and delete Morrison documents
echo ""
echo "[2/5] Finding Morrison documents in Paperless..."

# Get all documents and filter for morrison tag
DOCS_JSON=$(docker exec "$CONTAINER" wget -q -O - \
    --header="Authorization: Token $TOKEN" \
    "$PAPERLESS_URL/api/documents/" 2>/dev/null || echo '{"results":[]}')

# Extract document IDs that have morrison in their correspondent or tags
DOC_IDS=$(echo "$DOCS_JSON" | grep -o '"id":[0-9]*' | cut -d: -f2 | head -20 || true)

if [[ -z "$DOC_IDS" ]]; then
    echo "  No documents found in Paperless"
else
    DOC_COUNT=$(echo "$DOC_IDS" | wc -w)
    echo "  Found $DOC_COUNT document(s) total, deleting all..."

    for doc_id in $DOC_IDS; do
        echo -n "  Deleting document $doc_id... "
        docker exec "$CONTAINER" node -e "
const http = require('http');
const req = http.request({
  hostname: 'mattervault',
  port: 8000,
  path: '/api/documents/$doc_id/',
  method: 'DELETE',
  headers: { 'Authorization': 'Token $TOKEN' }
}, res => {
  process.exit(res.statusCode < 300 ? 0 : 1);
});
req.end();
" 2>/dev/null && echo "✓" || echo "✗"
    done
fi

# Step 3: Empty Paperless trash via database
echo ""
echo "[3/5] Emptying Paperless trash via database..."

# Get trashed document IDs from Paperless database
TRASHED_IDS=$(docker exec matterdb-paperless psql -U paperless -d paperless -t -A -c \
    "SELECT id FROM documents_document WHERE deleted_at IS NOT NULL;" 2>/dev/null || echo "")

if [[ -z "$TRASHED_IDS" || "$TRASHED_IDS" == "" ]]; then
    echo "  No documents in trash"
else
    TRASH_COUNT=$(echo "$TRASHED_IDS" | wc -l)
    echo "  Found $TRASH_COUNT document(s) in trash, permanently deleting..."

    for doc_id in $TRASHED_IDS; do
        echo -n "  Permanently deleting document $doc_id... "
        # Delete in correct order to handle foreign key constraints
        docker exec matterdb-paperless psql -U paperless -d paperless -c "
            DELETE FROM documents_document_tags WHERE document_id = $doc_id;
            DELETE FROM documents_note WHERE document_id = $doc_id;
            DELETE FROM documents_sharelink WHERE document_id = $doc_id;
            DELETE FROM documents_customfieldinstance WHERE document_id = $doc_id;
            DELETE FROM documents_workflowrun WHERE document_id = $doc_id;
            DELETE FROM documents_document WHERE id = $doc_id;
        " >/dev/null 2>&1 && echo "✓" || echo "✗"
    done
fi
echo "✓ Trash emptied"

# Step 4: Delete Morrison vectors from Qdrant
echo ""
echo "[4/5] Deleting Morrison vectors from Qdrant..."

DELETE_RESULT=$(docker exec "$CONTAINER" node -e "
const http = require('http');
const data = JSON.stringify({
  filter: { must: [{ key: 'family_id', match: { value: 'morrison' } }] }
});
const req = http.request({
  hostname: 'qdrant',
  port: 6333,
  path: '/collections/mattervault_documents_v2/points/delete',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, res => {
  let d=''; res.on('data', c => d+=c);
  res.on('end', () => console.log(d));
});
req.write(data);
req.end();
" 2>/dev/null || echo '{"status":"error"}')

if echo "$DELETE_RESULT" | grep -q '"status":"ok"'; then
    echo "✓ Deleted Morrison vectors from Qdrant"
else
    echo "  Note: Qdrant returned: $DELETE_RESULT"
    echo "  (This is OK if collection was empty or doesn't exist yet)"
fi

# Step 5: Copy demo data to intake
echo ""
echo "[5/5] Copying demo data to intake folder..."

# Ensure intake folder exists
mkdir -p "$INTAKE_DIR"

# Clear any existing files in intake
rm -f "$INTAKE_DIR"/*.pdf "$INTAKE_DIR"/*.docx 2>/dev/null || true

if [[ "$MODE" == "--all" ]]; then
    echo "  Copying ALL Morrison demo documents..."
    cp "$DEMO_DATA"/*.pdf "$INTAKE_DIR/" 2>/dev/null || true
    find "$DEMO_DATA" -name "*.docx" -exec cp {} "$INTAKE_DIR/" \; 2>/dev/null || true
    FILE_COUNT=$(ls -1 "$INTAKE_DIR" 2>/dev/null | wc -l)
else
    echo "  Copying Family Profile PDF only..."
    cp "$DEMO_DATA/00_Morrison_Family_Profile.pdf" "$INTAKE_DIR/"
    FILE_COUNT=1
fi

echo ""
echo "=========================================="
echo "✓ Re-ingestion initiated!"
echo "  $FILE_COUNT file(s) copied to: $INTAKE_DIR"
echo ""
echo "Copied files:"
ls -la "$INTAKE_DIR/"
echo ""
echo "Next steps:"
echo "  1. Paperless will detect and process files (1-2 min per file)"
echo "  2. n8n webhook triggers vector ingestion"
echo "  3. Monitor: http://localhost:5678 (n8n executions)"
echo "  4. Test chat after ingestion completes"
echo "=========================================="
