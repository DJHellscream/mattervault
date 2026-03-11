#!/usr/bin/env bash
# ==============================================================================
# Test: Centralized Configuration (.env as Single Source of Truth)
# ==============================================================================
# Verifies that env vars from .env propagate correctly to:
#   1. n8n container environment
#   2. n8n workflow Config node (resolved $env.* expressions)
#   3. Dashboard service health (DB passwords injected)
#   4. Dashboard dynamic family discovery
#   5. Chat-UI container environment
#   6. End-to-end chat smoke test
#
# This script auto-detects whether it's running on the host (localhost)
# or inside a Docker container (uses container hostnames via matternet).
#
# Prerequisites:
#   - Stack running: docker compose up -d --build
#   - Workflows imported: ./scripts/init-mattervault.sh
#
# Usage: ./scripts/test-centralized-config.sh
# ==============================================================================
set -euo pipefail

# Load .env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
    set -a
    source "$SCRIPT_DIR/../.env"
    set +a
fi

N8N_CONTAINER="${N8N_CONTAINER:-matterlogic}"

# Auto-detect environment: if localhost:5678 responds, use localhost URLs.
# Otherwise, use Docker container hostnames (running inside a container).
if curl -sf -o /dev/null --connect-timeout 2 "http://localhost:5678/healthz" 2>/dev/null; then
    N8N_API_URL="http://localhost:5678"
    DASHBOARD_URL="http://localhost:3006"
    CHATUI_URL="http://localhost:3007"
    QDRANT_API_URL="http://localhost:6333"
    N8N_WEBHOOK_URL="http://localhost:5678"
else
    # Inside a Docker container — use container hostnames on matternet
    N8N_API_URL="http://matterlogic:5678"
    DASHBOARD_URL="http://matterdash:3000"
    CHATUI_URL="http://matterchat:3000"
    QDRANT_API_URL="http://mattermemory:6333"
    N8N_WEBHOOK_URL="http://matterlogic:5678"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; WARN=$((WARN + 1)); }
header() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

echo "=============================================="
echo "  Centralized Config Verification"
echo "=============================================="
echo -e "  ${BLUE}→${NC} n8n API:   $N8N_API_URL"
echo -e "  ${BLUE}→${NC} Dashboard: $DASHBOARD_URL"
echo -e "  ${BLUE}→${NC} Qdrant:    $QDRANT_API_URL"

# ==============================================================================
# TEST 1: n8n Container Environment Variables
# ==============================================================================
header "1. n8n Container Environment"

EXPECTED_N8N_VARS=(
    "OLLAMA_URL=http://host.docker.internal:11434"
    "OLLAMA_CHAT_MODEL=llama3.1:8b"
    "OLLAMA_RERANKER_MODEL=llama3.1:8b"
    "OLLAMA_EMBEDDING_MODEL=nomic-embed-text"
    "DOCLING_URL=http://host.docker.internal:5001"
    "QDRANT_URL=http://mattermemory:6333"
    "QDRANT_COLLECTION=mattervault_documents_v2"
    "PAPERLESS_INTERNAL_URL=http://mattervault:8000"
    "N8N_INTERNAL_URL=http://matterlogic:5678"
)

for expected in "${EXPECTED_N8N_VARS[@]}"; do
    VAR_NAME="${expected%%=*}"
    VAR_VALUE="${expected#*=}"
    ACTUAL=$(docker exec "$N8N_CONTAINER" printenv "$VAR_NAME" 2>/dev/null || echo "NOT_SET")
    if [ "$ACTUAL" = "$VAR_VALUE" ]; then
        pass "$VAR_NAME=$VAR_VALUE"
    else
        fail "$VAR_NAME expected='$VAR_VALUE' actual='$ACTUAL'"
    fi
done

# ==============================================================================
# TEST 2: n8n Workflow Config Node (API check)
# ==============================================================================
header "2. n8n Workflow Config Node"

if [ -z "${N8N_API_KEY:-}" ]; then
    warn "N8N_API_KEY not set — skipping workflow API check"
else
    # Fetch chat workflow via API
    CHAT_WF_ID="wHoLnYdlFJoaHfDZ"
    RESPONSE=$(curl -sf -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_API_URL/api/v1/workflows/$CHAT_WF_ID" 2>/dev/null || echo "FAILED")

    if [ "$RESPONSE" = "FAILED" ]; then
        fail "Could not fetch chat workflow from n8n API"
    else
        # Check that the Config node contains $env references
        CONFIG_NODE=$(echo "$RESPONSE" | python3 -c "
import sys, json
wf = json.load(sys.stdin)
for node in wf.get('nodes', []):
    if node.get('id') == 'config-node':
        print(node['parameters']['jsonOutput'])
        break
" 2>/dev/null || echo "")

        if [ -z "$CONFIG_NODE" ]; then
            fail "Could not extract Config node from workflow"
        else
            for VAR in OLLAMA_CHAT_MODEL OLLAMA_RERANKER_MODEL OLLAMA_EMBEDDING_MODEL OLLAMA_URL QDRANT_URL QDRANT_COLLECTION; do
                if echo "$CONFIG_NODE" | grep -q "\$env\.$VAR"; then
                    pass "Config node references \$env.$VAR"
                else
                    fail "Config node missing \$env.$VAR"
                fi
            done
        fi

        # Check hybrid search URL uses config variable
        HYBRID_URL=$(echo "$RESPONSE" | python3 -c "
import sys, json
wf = json.load(sys.stdin)
for node in wf.get('nodes', []):
    if node.get('id') == 'hybrid-search':
        print(node['parameters']['url'])
        break
" 2>/dev/null || echo "")

        if echo "$HYBRID_URL" | grep -q "QDRANT_COLLECTION"; then
            pass "Hybrid Search URL uses config.QDRANT_COLLECTION"
        else
            fail "Hybrid Search URL still hardcoded: $HYBRID_URL"
        fi
    fi

    # Check ingestion workflow
    INGEST_WF_ID="ZIhqLsxBzrUam8bi"
    RESPONSE2=$(curl -sf -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_API_URL/api/v1/workflows/$INGEST_WF_ID" 2>/dev/null || echo "FAILED")

    if [ "$RESPONSE2" = "FAILED" ]; then
        fail "Could not fetch ingestion workflow from n8n API"
    else
        ENV_COUNT=$(echo "$RESPONSE2" | grep -o '\$env\.' | wc -l)
        if [ "$ENV_COUNT" -ge 8 ]; then
            pass "Ingestion workflow has $ENV_COUNT \$env references"
        else
            fail "Ingestion workflow only has $ENV_COUNT \$env references (expected ≥8)"
        fi

        PROCESS_ENV_COUNT=$(echo "$RESPONSE2" | grep -o 'process\.env\.' | wc -l)
        if [ "$PROCESS_ENV_COUNT" -ge 1 ]; then
            pass "Ingestion workflow has $PROCESS_ENV_COUNT process.env references"
        else
            fail "Ingestion workflow missing process.env references"
        fi
    fi

    # Check reconciliation workflow
    RECON_WF_ID="qmC66Y7q2qYPOfN6"
    RESPONSE3=$(curl -sf -H "X-N8N-API-KEY: $N8N_API_KEY" \
        "$N8N_API_URL/api/v1/workflows/$RECON_WF_ID" 2>/dev/null || echo "FAILED")

    if [ "$RESPONSE3" = "FAILED" ]; then
        fail "Could not fetch reconciliation workflow from n8n API"
    else
        ENV_COUNT3=$(echo "$RESPONSE3" | grep -o '\$env\.' | wc -l)
        if [ "$ENV_COUNT3" -ge 5 ]; then
            pass "Reconciliation workflow has $ENV_COUNT3 \$env references"
        else
            fail "Reconciliation workflow only has $ENV_COUNT3 \$env references (expected ≥5)"
        fi
    fi
fi

# ==============================================================================
# TEST 3: Dashboard Service Health (DB passwords working)
# ==============================================================================
header "3. Dashboard Service Health"

DASHBOARD_STATUS=$(curl -sf "$DASHBOARD_URL/api/status" 2>/dev/null || echo "FAILED")

if [ "$DASHBOARD_STATUS" = "FAILED" ]; then
    fail "Dashboard API not reachable at $DASHBOARD_URL"
else
    # Check each DB service (API may nest under 'services' key or be flat)
    for DB_ID in db-paperless db-n8n db-chatui; do
        STATUS=$(echo "$DASHBOARD_STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
services = data.get('services', data)
for svc_id, svc in services.items():
    if svc_id == '$DB_ID':
        print(svc.get('status', svc.get('current', {}).get('status', 'unknown')))
        break
else:
    print('not_found')
" 2>/dev/null || echo "error")

        if [ "$STATUS" = "up" ] || [ "$STATUS" = "healthy" ]; then
            pass "$DB_ID: $STATUS (password injected correctly)"
        elif [ "$STATUS" = "not_found" ]; then
            warn "$DB_ID: not in dashboard status (may need time)"
        else
            fail "$DB_ID: $STATUS (password injection may have failed)"
        fi
    done

    # Check Qdrant
    QDRANT_STATUS=$(echo "$DASHBOARD_STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
services = data.get('services', data)
svc = services.get('qdrant', {})
print(svc.get('status', svc.get('current', {}).get('status', 'unknown')))
" 2>/dev/null || echo "error")

    if [ "$QDRANT_STATUS" = "up" ] || [ "$QDRANT_STATUS" = "healthy" ]; then
        pass "qdrant: $QDRANT_STATUS"
    else
        fail "qdrant: $QDRANT_STATUS"
    fi
fi

# ==============================================================================
# TEST 4: Dashboard Dynamic Family Discovery
# ==============================================================================
header "4. Dashboard Metrics (Dynamic Families)"

# Retry up to 3 times (metrics cache may not be populated on first request)
DASHBOARD_METRICS="FAILED"
for _retry in 1 2 3; do
    DASHBOARD_METRICS=$(curl -sf "$DASHBOARD_URL/api/metrics" 2>/dev/null || echo "FAILED")
    if echo "$DASHBOARD_METRICS" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('services',{}).get('qdrant',{}).get('vector_count',0) > 0" 2>/dev/null; then
        break
    fi
    sleep 3
done

if [ "$DASHBOARD_METRICS" = "FAILED" ]; then
    fail "Dashboard metrics API not reachable"
else
    QDRANT_METRICS=$(echo "$DASHBOARD_METRICS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
qm = data.get('services', {}).get('qdrant', {})
families = qm.get('vectors_by_family', {})
count = qm.get('vector_count', 0)
print(f'vectors={count} families={json.dumps(families)}')
" 2>/dev/null || echo "error")

    if [ "$QDRANT_METRICS" = "error" ]; then
        warn "Could not parse Qdrant metrics"
    else
        echo -e "  ${BLUE}→${NC} Qdrant metrics: $QDRANT_METRICS"
        FAMILY_COUNT=$(echo "$DASHBOARD_METRICS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
families = data.get('services', {}).get('qdrant', {}).get('vectors_by_family', {})
print(len(families))
" 2>/dev/null || echo "0")

        if [ "$FAMILY_COUNT" -gt 0 ]; then
            pass "Dynamic family discovery found $FAMILY_COUNT families"
        elif [ "$FAMILY_COUNT" = "0" ]; then
            VECTOR_COUNT=$(echo "$DASHBOARD_METRICS" | python3 -c "
import sys, json
print(json.load(sys.stdin).get('qdrant', {}).get('vector_count', 0))
" 2>/dev/null || echo "0")
            if [ "$VECTOR_COUNT" = "0" ]; then
                warn "No vectors in Qdrant (empty collection) — family discovery has nothing to find"
            else
                fail "Vectors exist ($VECTOR_COUNT) but no families discovered"
            fi
        fi
    fi
fi

# ==============================================================================
# TEST 5: Chat-UI Container Environment
# ==============================================================================
header "5. Chat-UI Container Environment"

CHATUI_CONTAINER="matterchat"

# Try docker exec first, fall back to docker inspect if container isn't running
for VAR_CHECK in "OLLAMA_URL" "OLLAMA_MODEL"; do
    ACTUAL=$(docker exec "$CHATUI_CONTAINER" printenv "$VAR_CHECK" 2>/dev/null || echo "NOT_SET")
    if [ "$ACTUAL" != "NOT_SET" ] && [ -n "$ACTUAL" ]; then
        pass "$VAR_CHECK=$ACTUAL"
    else
        # Container may not be running — check config via docker inspect
        VALUE=$(docker inspect "$CHATUI_CONTAINER" --format '{{json .Config.Env}}' 2>/dev/null | \
            python3 -c "
import sys, json
envs = json.load(sys.stdin)
for e in envs:
    if e.startswith('$VAR_CHECK='):
        print(e)
        break
else:
    print('NOT_FOUND')
" 2>/dev/null || echo "NOT_FOUND")
        if [ "$VALUE" != "NOT_FOUND" ]; then
            pass "$VALUE (from container config — container not running)"
        else
            fail "$VAR_CHECK not set in chat-ui container"
        fi
    fi
done

# ==============================================================================
# TEST 6: Quick Smoke Test (Chat endpoint via n8n webhook)
# ==============================================================================
header "6. Smoke Test (Chat via n8n webhook)"

# Check if Qdrant has any vectors (needed for chat to work)
VECTOR_COUNT=$(curl -sf "$QDRANT_API_URL/collections/${QDRANT_COLLECTION:-mattervault_documents_v2}" 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('points_count',0))" 2>/dev/null || echo "0")

if [ "$VECTOR_COUNT" -gt 0 ]; then
    echo -e "  ${BLUE}→${NC} Qdrant has $VECTOR_COUNT vectors — attempting chat query..."

    # Get a family_id from Qdrant
    FAMILY=$(curl -sf -X POST "$QDRANT_API_URL/collections/${QDRANT_COLLECTION:-mattervault_documents_v2}/points/scroll" \
        -H "Content-Type: application/json" \
        -d '{"limit":1,"with_payload":{"include":["family_id"]},"with_vector":false}' 2>/dev/null | \
        python3 -c "import sys,json; pts=json.load(sys.stdin).get('result',{}).get('points',[]); print(pts[0]['payload']['family_id'] if pts else '')" 2>/dev/null || echo "")

    if [ -n "$FAMILY" ]; then
        echo -e "  ${BLUE}→${NC} Testing with family_id=$FAMILY"

        # Get a real user_id from the chatui database (conversations FK requires existing user)
        USER_ID=$(docker exec matterdb-chatui psql -U chatui -d chatui -t -A -c \
            "SELECT id FROM users WHERE paperless_username='admin' LIMIT 1" 2>&1 | grep -E '^[0-9a-f-]{36}$' || echo "")

        if [ -z "$USER_ID" ]; then
            warn "No user found in chatui DB — skip chat test"
        else
        echo -e "  ${BLUE}→${NC} Using user_id=$USER_ID"

        CHAT_RESPONSE=$(curl -sf --max-time 120 -X POST "$N8N_WEBHOOK_URL/webhook/chat-api-v3" \
            -H "Content-Type: application/json" \
            -d "{
                \"question\": \"What documents are available?\",
                \"family_id\": \"$FAMILY\",
                \"user_id\": \"$USER_ID\",
                \"paperless_username\": \"admin\"
            }" 2>/dev/null || echo "FAILED")

        if [ "$CHAT_RESPONSE" = "FAILED" ]; then
            fail "Chat query failed (n8n webhook returned error)"
        elif echo "$CHAT_RESPONSE" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r.get('output')" 2>/dev/null; then
            pass "Chat query returned a response via env-var-configured pipeline"
            # Show a snippet of the response
            SNIPPET=$(echo "$CHAT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output','')[:120])" 2>/dev/null || echo "")
            echo -e "  ${BLUE}→${NC} Response: ${SNIPPET}..."
        else
            fail "Chat query returned unexpected response: $(echo "$CHAT_RESPONSE" | head -c 200)"
        fi
        fi  # end user_id check
    else
        warn "Could not determine family_id — skip chat test"
    fi
else
    warn "Qdrant is empty ($VECTOR_COUNT vectors) — skip chat smoke test"
fi

# ==============================================================================
# SUMMARY
# ==============================================================================
echo ""
echo "=============================================="
echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$WARN warnings${NC}"
echo "=============================================="

if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}Some tests failed. Check output above for details.${NC}"
    exit 1
else
    echo -e "\n${GREEN}All tests passed!${NC}"
    exit 0
fi
