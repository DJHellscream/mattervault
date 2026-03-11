#!/usr/bin/env bash
# ==============================================================================
# Mattervault Pre-Consume Validation Script
# ==============================================================================
# Called by Paperless-ngx before consuming a document.
# Non-zero exit aborts consumption, leaving the file in place.
#
# Purpose: Reject documents from intake subfolders that don't match a known
# family tag. This prevents accidental ingestion into unrecognized tenants.
#
# Behavior:
#   - Documents NOT in intake/ subfolder → allowed (manual uploads, root consume)
#   - intake/<family>/ where <family> tag exists → allowed
#   - intake/<family>/ where <family> tag missing → REJECTED (file stays)
#   - API auth failure → allowed with warning (fail open)
# ==============================================================================

set -euo pipefail

SOURCE_PATH="${DOCUMENT_SOURCE_PATH:-}"

# No source path → not a file-based consume, allow
if [ -z "$SOURCE_PATH" ]; then
    exit 0
fi

# Normalize path to handle symlinks / relative segments (Paperless bug #1196)
REAL_PATH="$(realpath "$SOURCE_PATH" 2>/dev/null || echo "$SOURCE_PATH")"

# Check if the file is inside an intake subfolder
# Pattern: .../consume/intake/<family>/filename.pdf
if [[ "$REAL_PATH" != */consume/intake/*/* ]]; then
    # Not in an intake subfolder — manual upload or root consume, allow
    exit 0
fi

# Extract the family name (first directory component after intake/)
# e.g., /usr/src/paperless/consume/intake/morrison/doc.pdf → morrison
FAMILY_NAME="$(echo "$REAL_PATH" | sed 's|.*/consume/intake/\([^/]*\)/.*|\1|')"

if [ -z "$FAMILY_NAME" ]; then
    echo "pre-consume: could not extract family name from path: $REAL_PATH" >&2
    exit 0  # fail open
fi

# Query Paperless API for a tag matching this family name
PAPERLESS_URL="http://localhost:8000"
API_PASSWORD="${PAPERLESS_ADMIN_PASSWORD:-}"

if [ -z "$API_PASSWORD" ]; then
    echo "pre-consume: PAPERLESS_ADMIN_PASSWORD not set, cannot validate family tag" >&2
    exit 0  # fail open
fi

# Single API call: capture body and status code
RESPONSE_BODY=$(curl -s -w "\n%{http_code}" \
    -u "admin:${API_PASSWORD}" \
    "${PAPERLESS_URL}/api/tags/?name__iexact=${FAMILY_NAME}" 2>/dev/null) || {
    echo "pre-consume: WARNING - API request failed, allowing document (fail open)" >&2
    exit 0
}

HTTP_CODE="${RESPONSE_BODY##*$'\n'}"
RESPONSE_BODY="${RESPONSE_BODY%$'\n'*}"

if [ "$HTTP_CODE" != "200" ]; then
    echo "pre-consume: WARNING - API returned HTTP $HTTP_CODE, allowing document (fail open)" >&2
    exit 0
fi

TAG_COUNT=$(echo "$RESPONSE_BODY" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null) || {
    echo "pre-consume: WARNING - could not parse API response, allowing document (fail open)" >&2
    exit 0
}

if [ "$TAG_COUNT" -gt 0 ] 2>/dev/null; then
    echo "pre-consume: family tag '${FAMILY_NAME}' found, allowing document"
    exit 0
else
    echo "pre-consume: REJECTED - no tag '${FAMILY_NAME}' found. Create the tag in Paperless first." >&2
    exit 1
fi
