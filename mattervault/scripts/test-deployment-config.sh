#!/bin/bash
# ==============================================================================
# MATTERVAULT DEPLOYMENT CONFIG VALIDATION
# ------------------------------------------------------------------------------
# Tests that a fresh clone → .env setup → docker compose up would succeed.
# Three phases:
#   1. Config file validation (no Docker needed)
#   2. Fresh clone simulation (git archive to temp dir)
#   3. Docker smoke test (checks running containers)
# ==============================================================================

set -uo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; ((WARN++)); }
header() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Resolve project root (script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ============================================================================
# PHASE 1: CONFIG FILE VALIDATION
# ============================================================================
header "PHASE 1: Config File Validation"

# --- .gitignore ---
echo -e "\n  ${CYAN}[.gitignore]${NC}"
if [ -f .gitignore ]; then
    pass ".gitignore exists"
    if grep -q "^\.env$" .gitignore; then
        pass ".env is in .gitignore"
    else
        fail ".env is NOT in .gitignore"
    fi
else
    fail ".gitignore is missing"
fi

# --- .env not tracked ---
if git ls-files --error-unmatch .env 2>/dev/null; then
    fail ".env is still tracked by git"
else
    pass ".env is not tracked by git"
fi

# --- .env.example exists ---
echo -e "\n  ${CYAN}[.env.example]${NC}"
if [ -f .env.example ]; then
    pass ".env.example exists"
else
    fail ".env.example is missing — fresh clone would have no config template"
fi

# --- Extract required vars from .env.example ---
if [ -f .env.example ]; then
    EXAMPLE_VARS=$(grep -oP '^[A-Z][A-Z0-9_]+(?==)' .env.example | sort -u)

    # Check all .env.example vars appear in docker-compose.yml
    echo -e "\n  ${CYAN}[env var flow: .env.example → docker-compose.yml]${NC}"
    COMPOSE_CONTENT=$(cat docker-compose.yml)
    MISSING_IN_COMPOSE=0
    # These vars are used only in .env or don't need to be in compose
    SKIP_VARS="PAPERLESS_DB_PASS PAPERLESS_SECRET PAPERLESS_ADMIN_PASS N8N_DB_PASS N8N_AUTH_PASS N8N_API_KEY CHATUI_DB_PASS JWT_SECRET MATTERVAULT_DATA_DIR PAPERLESS_USER PAPERLESS_PASS"
    for var in $EXAMPLE_VARS; do
        # Skip vars that are consumed directly by compose ${} syntax or don't need explicit env
        if echo "$SKIP_VARS" | grep -qw "$var"; then
            continue
        fi
        if echo "$COMPOSE_CONTENT" | grep -q "\${${var}" || echo "$COMPOSE_CONTENT" | grep -q "${var}:"; then
            pass "$var flows to docker-compose.yml"
        else
            fail "$var defined in .env.example but not referenced in docker-compose.yml"
            ((MISSING_IN_COMPOSE++))
        fi
    done
fi

# --- Model references ---
echo -e "\n  ${CYAN}[model consistency]${NC}"
EXPECTED_CHAT_MODEL="qwen3:8b"
EXPECTED_EMBED_MODEL="nomic-embed-text"

for file in .env.example docker-compose.yml; do
    if grep -q "OLLAMA_CHAT_MODEL.*${EXPECTED_CHAT_MODEL}" "$file"; then
        pass "$file: OLLAMA_CHAT_MODEL = $EXPECTED_CHAT_MODEL"
    else
        ACTUAL=$(grep -oP 'OLLAMA_CHAT_MODEL[=:][^}]*' "$file" | head -1)
        fail "$file: OLLAMA_CHAT_MODEL expected $EXPECTED_CHAT_MODEL, got: $ACTUAL"
    fi
done

for file in .env.example docker-compose.yml; do
    if grep -q "OLLAMA_RERANKER_MODEL.*${EXPECTED_CHAT_MODEL}" "$file"; then
        pass "$file: OLLAMA_RERANKER_MODEL = $EXPECTED_CHAT_MODEL"
    else
        ACTUAL=$(grep -oP 'OLLAMA_RERANKER_MODEL[=:][^}]*' "$file" | head -1)
        fail "$file: OLLAMA_RERANKER_MODEL expected $EXPECTED_CHAT_MODEL, got: $ACTUAL"
    fi
done

# --- Stale model references in core config ---
echo -e "\n  ${CYAN}[stale model references]${NC}"
CORE_FILES=".env.example docker-compose.yml CLAUDE.md"
for file in $CORE_FILES; do
    if [ -f "$file" ]; then
        if grep -q "llama3\.1:8b" "$file"; then
            fail "$file still contains llama3.1:8b"
        else
            pass "$file: no stale llama3.1:8b references"
        fi
    fi
done

# --- Hardcoded URLs check ---
echo -e "\n  ${CYAN}[hardcoded URLs in compose]${NC}"
# Chat-UI and Dashboard PAPERLESS_URL should use ${PAPERLESS_INTERNAL_URL:-...}
# We check the environment sections of chat-ui and dashboard specifically
CHAT_UI_SECTION=$(sed -n '/container_name: matterchat/,/networks:/p' docker-compose.yml)
DASH_SECTION=$(sed -n '/container_name: matterdash/,/networks:/p' docker-compose.yml)

if echo "$CHAT_UI_SECTION" | grep -q 'PAPERLESS_URL=\${PAPERLESS_INTERNAL_URL'; then
    pass "chat-ui PAPERLESS_URL uses \${PAPERLESS_INTERNAL_URL:-...}"
else
    fail "chat-ui PAPERLESS_URL is hardcoded (should use \${PAPERLESS_INTERNAL_URL:-...})"
fi

if echo "$CHAT_UI_SECTION" | grep -q 'N8N_WEBHOOK_URL=\${N8N_INTERNAL_URL'; then
    pass "chat-ui N8N_WEBHOOK_URL uses \${N8N_INTERNAL_URL:-...}"
else
    fail "chat-ui N8N_WEBHOOK_URL is hardcoded (should use \${N8N_INTERNAL_URL:-...})"
fi

if echo "$DASH_SECTION" | grep -q 'PAPERLESS_URL=\${PAPERLESS_INTERNAL_URL'; then
    pass "dashboard PAPERLESS_URL uses \${PAPERLESS_INTERNAL_URL:-...}"
else
    fail "dashboard PAPERLESS_URL is hardcoded (should use \${PAPERLESS_INTERNAL_URL:-...})"
fi

# --- PAPERLESS_USER/PASS configurable ---
echo -e "\n  ${CYAN}[PAPERLESS_USER/PASS configurability]${NC}"
if echo "$CHAT_UI_SECTION" | grep -q 'PAPERLESS_USER=\${PAPERLESS_USER'; then
    pass "chat-ui PAPERLESS_USER is configurable"
else
    fail "chat-ui PAPERLESS_USER is hardcoded"
fi
if echo "$DASH_SECTION" | grep -q 'PAPERLESS_USER=\${PAPERLESS_USER'; then
    pass "dashboard PAPERLESS_USER is configurable"
else
    fail "dashboard PAPERLESS_USER is hardcoded"
fi

# --- Critical files exist ---
echo -e "\n  ${CYAN}[critical files for fresh deployment]${NC}"
CRITICAL_FILES=(
    "scripts/pre-consume-validate.sh:Pre-consume validation script"
    "chat-ui/migrations/006_reconciliation_family_update.sql:Reconciliation migration"
    "docker-compose.test.yml:E2E test compose"
    "scripts/init-mattervault.sh:Init script"
    "FUTURE_ROADMAP.md:Roadmap doc"
)
for entry in "${CRITICAL_FILES[@]}"; do
    file="${entry%%:*}"
    desc="${entry#*:}"
    if [ -f "$file" ]; then
        pass "$file exists ($desc)"
    else
        fail "$file missing ($desc)"
    fi
done

# --- Volume mount targets ---
echo -e "\n  ${CYAN}[volume mount script references]${NC}"
if grep -q "pre-consume-validate.sh" docker-compose.yml; then
    pass "docker-compose.yml mounts pre-consume-validate.sh"
else
    fail "docker-compose.yml does not mount pre-consume-validate.sh"
fi

# --- CLAUDE.md consistency ---
echo -e "\n  ${CYAN}[CLAUDE.md consistency]${NC}"
if grep -q "\.env.*excluded.*gitignore" CLAUDE.md 2>/dev/null; then
    pass "CLAUDE.md documents .env exclusion"
else
    fail "CLAUDE.md missing .env management documentation"
fi
if grep -q "cp .env.example .env" CLAUDE.md 2>/dev/null; then
    pass "CLAUDE.md documents .env.example workflow"
else
    fail "CLAUDE.md missing .env.example setup instructions"
fi

# --- Docker healthcheck directives ---
echo -e "\n  ${CYAN}[Docker healthcheck directives]${NC}"
HEALTHCHECK_SERVICES="paperless n8n chat-ui health-dashboard qdrant"
for service in $HEALTHCHECK_SERVICES; do
    if grep -A 40 "^\s*${service}:" docker-compose.yml | grep -q "healthcheck:"; then
        pass "$service has healthcheck directive"
    else
        fail "$service missing healthcheck directive"
    fi
done

# --- Docker resource limits ---
echo -e "\n  ${CYAN}[Docker resource limits]${NC}"
RESOURCE_SERVICES="paperless n8n qdrant db-paperless db-n8n db-chatui redis chat-ui health-dashboard gotenberg tika"
for service in $RESOURCE_SERVICES; do
    if grep -A 40 "^\s*${service}:" docker-compose.yml | grep -q "deploy:"; then
        pass "$service has resource limits"
    else
        fail "$service missing resource limits"
    fi
done

# ============================================================================
# PHASE 2: FRESH CLONE SIMULATION
# ============================================================================
header "PHASE 2: Fresh Clone Simulation"

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo -e "  Simulating fresh clone to $TMPDIR..."

# Use git archive to simulate what a clone would produce (only tracked files)
git -C "$(git rev-parse --show-toplevel)" archive HEAD -- mattervault/ | tar -x -C "$TMPDIR" 2>/dev/null

CLONE_DIR="$TMPDIR/mattervault"
if [ ! -d "$CLONE_DIR" ]; then
    fail "git archive produced no mattervault directory"
else
    pass "git archive produced mattervault directory"

    echo -e "\n  ${CYAN}[secrets not in clone]${NC}"
    if [ -f "$CLONE_DIR/.env" ]; then
        fail ".env present in clone (secrets leaked!)"
    else
        pass ".env is NOT in clone"
    fi

    echo -e "\n  ${CYAN}[template present]${NC}"
    if [ -f "$CLONE_DIR/.env.example" ]; then
        pass ".env.example is in clone"
    else
        fail ".env.example missing from clone"
    fi

    echo -e "\n  ${CYAN}[simulating setup: cp .env.example .env]${NC}"
    if cp "$CLONE_DIR/.env.example" "$CLONE_DIR/.env" 2>/dev/null; then
        pass "cp .env.example .env succeeded"

        # Verify all CHANGE_ME placeholders exist (user knows what to edit)
        CHANGE_COUNT=$(grep -c "CHANGE_ME" "$CLONE_DIR/.env" || true)
        if [ "$CHANGE_COUNT" -gt 0 ]; then
            pass "$CHANGE_COUNT CHANGE_ME placeholders found (user knows what to edit)"
        else
            warn "No CHANGE_ME placeholders — user might miss required edits"
        fi
    else
        fail "cp .env.example .env failed"
    fi

    echo -e "\n  ${CYAN}[docker compose config validation]${NC}"
    # Validate compose file parses correctly with the template .env
    cd "$CLONE_DIR"
    if docker compose config --quiet 2>/dev/null; then
        pass "docker compose config validates with .env.example values"
    else
        # Try again and capture error
        ERROR=$(docker compose config 2>&1 | tail -5)
        fail "docker compose config fails: $ERROR"
    fi
    cd "$PROJECT_DIR"

    echo -e "\n  ${CYAN}[critical files in clone]${NC}"
    for entry in "${CRITICAL_FILES[@]}"; do
        file="${entry%%:*}"
        desc="${entry#*:}"
        if [ -f "$CLONE_DIR/$file" ]; then
            pass "$file in clone ($desc)"
        else
            fail "$file missing from clone ($desc)"
        fi
    done
fi

# ============================================================================
# PHASE 3: DOCKER SMOKE TEST
# ============================================================================
header "PHASE 3: Docker Smoke Test (Running Containers)"

cd "$PROJECT_DIR"

# Check if containers are running
RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | sort)
EXPECTED_CONTAINERS="mattercache matterchat matterdash matterdb-chatui matterdb-n8n matterdb-paperless matterlogic mattermemory mattervault"

echo -e "\n  ${CYAN}[container status]${NC}"
for container in $EXPECTED_CONTAINERS; do
    if echo "$RUNNING" | grep -q "^${container}$"; then
        pass "$container is running"
    else
        fail "$container is NOT running"
    fi
done

# Check env vars inside running containers
echo -e "\n  ${CYAN}[env vars in running containers]${NC}"

# n8n (matterlogic) — should have correct model
if docker ps --format '{{.Names}}' | grep -q "^matterlogic$"; then
    N8N_CHAT_MODEL=$(docker exec matterlogic printenv OLLAMA_CHAT_MODEL 2>/dev/null || echo "NOT_SET")
    N8N_RERANKER=$(docker exec matterlogic printenv OLLAMA_RERANKER_MODEL 2>/dev/null || echo "NOT_SET")
    N8N_PAPERLESS=$(docker exec matterlogic printenv PAPERLESS_INTERNAL_URL 2>/dev/null || echo "NOT_SET")

    if [ "$N8N_CHAT_MODEL" = "$EXPECTED_CHAT_MODEL" ]; then
        pass "matterlogic OLLAMA_CHAT_MODEL = $N8N_CHAT_MODEL"
    else
        warn "matterlogic OLLAMA_CHAT_MODEL = $N8N_CHAT_MODEL (expected $EXPECTED_CHAT_MODEL — restart needed?)"
    fi
    if [ "$N8N_RERANKER" = "$EXPECTED_CHAT_MODEL" ]; then
        pass "matterlogic OLLAMA_RERANKER_MODEL = $N8N_RERANKER"
    else
        warn "matterlogic OLLAMA_RERANKER_MODEL = $N8N_RERANKER (expected $EXPECTED_CHAT_MODEL — restart needed?)"
    fi
    if [ "$N8N_PAPERLESS" != "NOT_SET" ]; then
        pass "matterlogic PAPERLESS_INTERNAL_URL = $N8N_PAPERLESS"
    else
        warn "matterlogic PAPERLESS_INTERNAL_URL not set"
    fi
fi

# Chat-UI (matterchat)
if docker ps --format '{{.Names}}' | grep -q "^matterchat$"; then
    CHAT_PAPERLESS=$(docker exec matterchat printenv PAPERLESS_URL 2>/dev/null || echo "NOT_SET")
    CHAT_USER=$(docker exec matterchat printenv PAPERLESS_USER 2>/dev/null || echo "NOT_SET")
    CHAT_MODEL=$(docker exec matterchat printenv OLLAMA_MODEL 2>/dev/null || echo "NOT_SET")

    if [ "$CHAT_PAPERLESS" != "NOT_SET" ]; then
        pass "matterchat PAPERLESS_URL = $CHAT_PAPERLESS"
    else
        fail "matterchat PAPERLESS_URL not set"
    fi
    if [ "$CHAT_USER" != "NOT_SET" ]; then
        pass "matterchat PAPERLESS_USER = $CHAT_USER"
    else
        fail "matterchat PAPERLESS_USER not set"
    fi
    if [ "$CHAT_MODEL" = "$EXPECTED_CHAT_MODEL" ]; then
        pass "matterchat OLLAMA_MODEL = $CHAT_MODEL"
    else
        warn "matterchat OLLAMA_MODEL = $CHAT_MODEL (expected $EXPECTED_CHAT_MODEL — restart needed?)"
    fi
fi

# Dashboard (matterdash)
if docker ps --format '{{.Names}}' | grep -q "^matterdash$"; then
    DASH_PAPERLESS=$(docker exec matterdash printenv PAPERLESS_URL 2>/dev/null || echo "NOT_SET")
    DASH_USER=$(docker exec matterdash printenv PAPERLESS_USER 2>/dev/null || echo "NOT_SET")

    if [ "$DASH_PAPERLESS" != "NOT_SET" ]; then
        pass "matterdash PAPERLESS_URL = $DASH_PAPERLESS"
    else
        fail "matterdash PAPERLESS_URL not set"
    fi
    if [ "$DASH_USER" != "NOT_SET" ]; then
        pass "matterdash PAPERLESS_USER = $DASH_USER"
    else
        fail "matterdash PAPERLESS_USER not set"
    fi
fi

# --- Service health checks ---
# Most containers don't have curl, so use mattertest (alpine-based with curl)
echo -e "\n  ${CYAN}[service health]${NC}"
HEALTH_RUNNER=""
if docker ps --format '{{.Names}}' | grep -q "^mattertest$"; then
    HEALTH_RUNNER="mattertest"
elif docker ps --format '{{.Names}}' | grep -q "^mattervault$"; then
    # Paperless image has curl
    HEALTH_RUNNER="mattervault"
fi

if [ -n "$HEALTH_RUNNER" ]; then
    # Paperless
    if docker exec "$HEALTH_RUNNER" curl -sf http://mattervault:8000/api/ > /dev/null 2>&1; then
        pass "Paperless API responding"
    else
        warn "Paperless API not responding (may still be starting)"
    fi

    # Qdrant
    if docker exec "$HEALTH_RUNNER" curl -sf http://mattermemory:6333/healthz > /dev/null 2>&1; then
        pass "Qdrant health OK"
    else
        warn "Qdrant health check failed"
    fi

    # n8n
    if docker exec "$HEALTH_RUNNER" curl -sf http://matterlogic:5678/healthz > /dev/null 2>&1; then
        pass "n8n health OK"
    else
        warn "n8n health check failed (may require auth)"
    fi
else
    warn "No container with curl available — skipping service health checks"
fi

# ============================================================================
# SUMMARY
# ============================================================================
header "RESULTS"
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo -e "  ${YELLOW}Warnings: $WARN${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo -e "  ${GREEN}All checks passed!${NC}"
    if [ "$WARN" -gt 0 ]; then
        echo -e "  ${YELLOW}Warnings likely mean containers need restart to pick up new config.${NC}"
        echo -e "  ${YELLOW}Run: docker compose up -d (in mattervault/)${NC}"
    fi
    exit 0
else
    echo -e "  ${RED}$FAIL check(s) failed. Review above for details.${NC}"
    exit 1
fi
