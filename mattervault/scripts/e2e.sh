#!/bin/bash
# ==============================================================================
# Mattervault E2E Test Runner
# Usage: ./scripts/e2e.sh [reset|test|full]
#
# This script:
# 1. Builds/starts the e2e container (if needed)
# 2. Runs the test inside the Docker network
# ==============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-full}"

echo "Building/starting e2e container..."
docker compose --profile test build e2e 2>/dev/null
docker compose --profile test up -d e2e 2>/dev/null

echo "Running E2E test (mode: $MODE)..."
docker exec e2e-runner /e2e/test.sh "$MODE"
