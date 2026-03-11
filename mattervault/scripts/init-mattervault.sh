#!/usr/bin/env bash
# ==============================================================================
# Mattervault Initialization Script
# Run this ONCE after 'docker compose up -d' on a fresh installation
#
# This script:
#   1. Waits for all services to be healthy
#   2. Creates Qdrant V3 collection with hybrid search schema
#   3. Imports n8n workflows
#   4. Creates ingestion status tags (processing, ai_ready, ingestion_error)
#   5. Creates Paperless webhooks to n8n
#
# Prerequisites:
#   - Docker services running (docker compose up -d)
#   - .env file configured with passwords
#
# Usage: ./scripts/init-mattervault.sh
# ==============================================================================
set -euo pipefail

# Load environment from .env if present
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

# Configuration (host-side URLs — convert Docker-internal hostnames to localhost)
PAPERLESS_URL="${PAPERLESS_URL:-http://localhost:8000}"
PAPERLESS_URL="${PAPERLESS_URL/mattervault:8000/localhost:8000}"
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
QDRANT_URL="${QDRANT_URL/mattermemory:6333/localhost:6333}"
N8N_CONTAINER="${N8N_CONTAINER:-matterlogic}"
PAPERLESS_USER="${PAPERLESS_USER:-admin}"
PAPERLESS_PASS="${PAPERLESS_ADMIN_PASS:-mattervault2025}"
WORKFLOW_DIR="$SCRIPT_DIR/../n8n-workflows"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
info() { echo -e "${BLUE}→${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
header() { echo -e "\n${YELLOW}=== $1 ===${NC}"; }

echo "=============================================="
echo "  Mattervault Initialization"
echo "=============================================="
echo ""

# ==============================================================================
# STEP 1: Wait for Services
# ==============================================================================
header "Step 1: Waiting for Services"

wait_for_service() {
    local name="$1"
    local url="$2"
    local max_attempts="${3:-30}"

    for i in $(seq 1 $max_attempts); do
        if curl -sf "$url" >/dev/null 2>&1; then
            pass "$name is ready"
            return 0
        fi
        echo -n "."
        sleep 2
    done
    fail "$name not responding at $url"
    return 1
}

wait_for_service "Qdrant" "$QDRANT_URL/collections"
wait_for_service "Paperless" "$PAPERLESS_URL/api/"

# Check n8n container
if docker exec "$N8N_CONTAINER" echo "ok" >/dev/null 2>&1; then
    pass "n8n container ($N8N_CONTAINER) is running"
else
    fail "n8n container ($N8N_CONTAINER) not found"
    exit 1
fi

# ==============================================================================
# STEP 2: Initialize Qdrant Collection
# ==============================================================================
header "Step 2: Qdrant Collection (V3 Hybrid)"

COLLECTION="${QDRANT_COLLECTION:-mattervault_documents_v3}"
EXISTS=$(curl -sf "$QDRANT_URL/collections/$COLLECTION" 2>/dev/null | grep -q "points_count" && echo "YES" || echo "NO")

if [ "$EXISTS" = "NO" ]; then
    info "Creating collection with hybrid search schema..."

    curl -sf -X PUT "$QDRANT_URL/collections/$COLLECTION" \
        -H "Content-Type: application/json" \
        -d '{
            "vectors": {
                "dense": {
                    "size": 1024,
                    "distance": "Cosine"
                }
            },
            "sparse_vectors": {
                "bm25": {
                    "modifier": "idf"
                }
            }
        }' >/dev/null || { fail "Failed to create collection"; exit 1; }

    # Create indexes
    # family_id uses tenant-aware index for optimized per-family queries
    curl -sf -X PUT "$QDRANT_URL/collections/$COLLECTION/index" \
        -H "Content-Type: application/json" \
        -d '{"field_name":"family_id","field_schema":{"type":"keyword","is_tenant":true}}' >/dev/null 2>&1 || true

    curl -sf -X PUT "$QDRANT_URL/collections/$COLLECTION/index" \
        -H "Content-Type: application/json" \
        -d '{"field_name":"document_id","field_schema":"keyword"}' >/dev/null 2>&1 || true

    pass "Created $COLLECTION with indexes"
else
    pass "Collection $COLLECTION already exists"
fi

# ==============================================================================
# STEP 3: Import n8n Workflows
# ==============================================================================
header "Step 3: n8n Workflows"

# Workflow files and their known IDs (for activation after import)
WORKFLOWS=(
    "document-ingestion-v2.json"
    "mattervault-chat-v5.json"
    "document-reconciliation.json"
    "audit-partition-maintenance.json"
    "audit-archive.json"
)

WORKFLOW_IDS=()

for wf in "${WORKFLOWS[@]}"; do
    WF_PATH="$WORKFLOW_DIR/$wf"
    if [ -f "$WF_PATH" ]; then
        info "Importing $wf..."
        docker cp "$WF_PATH" "$N8N_CONTAINER:/tmp/$wf"
        if docker exec "$N8N_CONTAINER" n8n import:workflow --input="/tmp/$wf" >/dev/null 2>&1; then
            # Extract workflow ID from the JSON file for activation
            WF_ID=$(python3 -c "
import json, sys
d = json.load(open('$WF_PATH'))
if isinstance(d, list): d = d[0]
print(d.get('id', ''))
" 2>/dev/null || echo "")
            [ -n "$WF_ID" ] && WORKFLOW_IDS+=("$WF_ID")
            pass "Imported $wf"
        else
            warn "Failed to import $wf (may already exist)"
        fi
    else
        warn "Workflow file not found: $wf"
    fi
done

info "Restarting n8n to pick up imported workflows..."
docker restart "$N8N_CONTAINER" >/dev/null 2>&1
sleep 8

# n8n import:workflow deactivates workflows regardless of the active flag in JSON.
# Explicitly activate each imported workflow after restart.
info "Activating workflows..."
ACTIVATED=0
for WF_ID in "${WORKFLOW_IDS[@]}"; do
    if docker exec "$N8N_CONTAINER" n8n publish:workflow --id="$WF_ID" >/dev/null 2>&1; then
        ACTIVATED=$((ACTIVATED + 1))
    else
        warn "Could not activate workflow $WF_ID"
    fi
done

# Restart again so activations take effect
docker restart "$N8N_CONTAINER" >/dev/null 2>&1
sleep 5

# Verify
ACTIVE_COUNT=$(docker exec "$N8N_CONTAINER" n8n list:workflow --active=true 2>/dev/null | wc -l)
pass "n8n ready — $ACTIVE_COUNT workflow(s) active"

# ==============================================================================
# STEP 4: Ingestion Status Tags
# ==============================================================================
header "Step 4: Ingestion Status Tags"

info "Authenticating with Paperless..."
TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    fail "Could not authenticate with Paperless"
    warn "Create status tags and webhooks manually in Paperless admin"
else
    pass "Authenticated with Paperless"

    info "Creating ingestion status tags..."
    for tag_name in "processing" "ai_ready" "ingestion_error"; do
        EXISTING=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=$tag_name" \
            -H "Authorization: Token $TOKEN" 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2)
        if [ "${EXISTING:-0}" -gt 0 ]; then
            pass "Tag '$tag_name' already exists"
        else
            COLOR="#808080"
            [ "$tag_name" = "processing" ] && COLOR="#FFA500"
            [ "$tag_name" = "ai_ready" ] && COLOR="#28A745"
            [ "$tag_name" = "ingestion_error" ] && COLOR="#DC3545"
            curl -sf -X POST "$PAPERLESS_URL/api/tags/" \
                -H "Authorization: Token $TOKEN" \
                -H "Content-Type: application/json" \
                -d "{\"name\":\"$tag_name\",\"color\":\"$COLOR\",\"is_inbox_tag\":false}" >/dev/null 2>&1 \
                && pass "Created tag '$tag_name'" || warn "Failed to create tag '$tag_name'"
        fi
    done
fi

# ==============================================================================
# STEP 5: Create Paperless Webhooks
# ==============================================================================
header "Step 5: Paperless Webhooks"

# Re-use existing TOKEN from Step 4, or re-authenticate if needed
if [ -z "$TOKEN" ]; then
    info "Re-authenticating with Paperless..."
    TOKEN=$(curl -sf "$PAPERLESS_URL/api/token/" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$PAPERLESS_USER\",\"password\":\"$PAPERLESS_PASS\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
fi

if [ -z "$TOKEN" ]; then
    fail "Could not authenticate with Paperless"
    warn "Create webhooks manually in Paperless admin"
else
    # Check existing workflows
    EXISTING=$(curl -sf "$PAPERLESS_URL/api/workflows/" -H "Authorization: Token $TOKEN" | grep -o '"count":[0-9]*' | cut -d: -f2)

    if [ "${EXISTING:-0}" -ge 2 ]; then
        pass "Paperless webhooks already configured ($EXISTING workflows)"
    else
        info "Creating Paperless webhooks..."

        # Workflow 1: Document Added
        curl -sf -X POST "$PAPERLESS_URL/api/workflows/" \
            -H "Authorization: Token $TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
                "name": "n8n Document Added",
                "order": 1,
                "enabled": true,
                "triggers": [{
                    "type": 2,
                    "matching_algorithm": 0,
                    "match": "",
                    "is_insensitive": true
                }],
                "actions": [{
                    "type": 4,
                    "webhook": {
                        "url": "http://matterlogic:5678/webhook/document-added-v2",
                        "use_params": false,
                        "as_json": true,
                        "body": "{\"doc_url\": \"{{doc_url}}\", \"title\": \"{{doc_title}}\"}"
                    }
                }]
            }' >/dev/null 2>&1 && pass "Created 'Document Added' webhook" || warn "Failed to create Document Added webhook"

        # Workflow 2: Document Updated
        curl -sf -X POST "$PAPERLESS_URL/api/workflows/" \
            -H "Authorization: Token $TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
                "name": "n8n Document Updated",
                "order": 2,
                "enabled": true,
                "triggers": [{
                    "type": 3,
                    "matching_algorithm": 0,
                    "match": "",
                    "is_insensitive": true
                }],
                "actions": [{
                    "type": 4,
                    "webhook": {
                        "url": "http://matterlogic:5678/webhook/document-added-v2",
                        "use_params": false,
                        "as_json": true,
                        "body": "{\"doc_url\": \"{{doc_url}}\", \"title\": \"{{doc_title}}\"}"
                    }
                }]
            }' >/dev/null 2>&1 && pass "Created 'Document Updated' webhook" || warn "Failed to create Document Updated webhook"
    fi
fi

# ==============================================================================
# SUMMARY
# ==============================================================================
header "Initialization Complete"

echo ""
echo "Services:"
echo "  - Chat UI:    http://localhost:3007"
echo "  - Paperless:  http://localhost:8000"
echo "  - n8n:        http://localhost:5678"
echo "  - Qdrant:     http://localhost:6333/dashboard"
echo "  - Dashboard:  http://localhost:3006"
echo ""
echo "Next steps:"
echo "  1. Login to Paperless (admin / $PAPERLESS_PASS)"
echo "  2. Create intake folders for your families (e.g., ./intake/smith/)"
echo "  3. Configure Paperless consumer to watch intake folders"
echo "  4. Drop PDFs into intake folders to start ingesting"
echo ""
echo "To verify n8n workflows are active:"
echo "  docker exec $N8N_CONTAINER n8n list:workflow --active=true"
echo ""
echo "=============================================="
