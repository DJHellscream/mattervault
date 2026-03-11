#!/usr/bin/env bash
# ==============================================================================
# Mattervault Health Check Script
# Validates all services (Docker + Native) are running and responsive
# Usage: ./scripts/health-check.sh
# Exit codes: 0 = all healthy, 1 = one or more failures
# ==============================================================================
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FAILURES=0

check_service() {
    local name="$1"
    local cmd="$2"

    printf "%-25s" "Checking $name..."

    if eval "$cmd" > /dev/null 2>&1; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        echo -e "${RED}FAILED${NC}"
        ((FAILURES++)) || true
        return 1
    fi
}

echo "=============================================="
echo "  Mattervault Health Check"
echo "=============================================="
echo ""

# Docker containers
echo -e "${YELLOW}Docker Services:${NC}"
check_service "Redis (mattercache)" "docker ps --filter 'name=mattercache' --filter 'status=running' | grep -q mattercache"
check_service "Postgres-Paperless" "docker ps --filter 'name=matterdb-paperless' --filter 'status=running' | grep -q matterdb-paperless"
check_service "Postgres-n8n" "docker ps --filter 'name=matterdb-n8n' --filter 'status=running' | grep -q matterdb-n8n"
check_service "Gotenberg" "docker ps --filter 'name=matterconvert' --filter 'status=running' | grep -q matterconvert"
check_service "Tika" "docker ps --filter 'name=matterparse' --filter 'status=running' | grep -q matterparse"
check_service "Paperless-ngx" "docker ps --filter 'name=mattervault' --filter 'status=running' | grep -q mattervault"
check_service "Qdrant" "docker ps --filter 'name=mattermemory' --filter 'status=running' | grep -q mattermemory"
check_service "n8n" "docker ps --filter 'name=matterlogic' --filter 'status=running' | grep -q matterlogic"

echo ""

# Native services (via HTTP)
echo -e "${YELLOW}Native Services:${NC}"
check_service "Ollama (localhost:11434)" "curl -sf http://localhost:11434/api/tags"
check_service "Docling (localhost:5001)" "curl -sf http://localhost:5001/health"

echo ""

# Web endpoints
echo -e "${YELLOW}Web Endpoints:${NC}"
check_service "Paperless UI (8000)" "curl -sf http://localhost:8000/api/ -o /dev/null"
check_service "n8n UI (5678)" "curl -sf http://localhost:5678/ -o /dev/null"
check_service "Qdrant Dashboard (6333)" "curl -sf http://localhost:6333/dashboard/"

echo ""

# Qdrant collection check
echo -e "${YELLOW}Qdrant Collections:${NC}"
printf "%-25s" "Checking collections..."
COLLECTIONS=$(curl -sf http://localhost:6333/collections 2>/dev/null || echo "")
if echo "$COLLECTIONS" | grep -q "mattervault_documents"; then
    echo -e "${GREEN}mattervault_documents exists${NC}"
else
    echo -e "${YELLOW}mattervault_documents not found (create it)${NC}"
fi

echo ""
echo "=============================================="

if [ $FAILURES -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
    exit 0
else
    echo -e "${RED}$FAILURES check(s) failed${NC}"
    exit 1
fi
