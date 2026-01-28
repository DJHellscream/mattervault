#!/bin/bash
# n8n Workflow Management Script
# Usage: ./n8n-workflow.sh <command> [args]
#
# Commands:
#   list                    - List all workflows
#   list-active             - List only active workflows
#   export <id> <file>      - Export workflow to local JSON file
#   import <file>           - Import/update workflow from JSON file (overwrites if ID exists)
#   delete <id> [id2...]    - Delete workflow(s) by ID
#   activate <id>           - Activate a workflow
#   deactivate <id>         - Deactivate a workflow

set -euo pipefail

CONTAINER="matterlogic"
API_KEY="${N8N_API_KEY:-}"

# Load API key from .env if not set
if [[ -z "$API_KEY" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ENV_FILE="$SCRIPT_DIR/../.env"
    if [[ -f "$ENV_FILE" ]]; then
        API_KEY=$(grep -E '^N8N_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
    fi
fi

if [[ -z "$API_KEY" ]]; then
    echo "Error: N8N_API_KEY not found in environment or .env file"
    exit 1
fi

# Helper: Make API request from inside container
api_request() {
    local method="$1"
    local path="$2"
    local data="${3:-}"

    docker exec "$CONTAINER" node -e "
const http = require('http');
const options = {
  hostname: 'localhost',
  port: 5678,
  path: '$path',
  method: '$method',
  headers: {
    'X-N8N-API-KEY': '$API_KEY',
    'Content-Type': 'application/json'
  }
};
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    process.stdout.write(data);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});
req.on('error', e => { console.error(e.message); process.exit(1); });
if ('$data') req.write('$data');
req.end();
"
}

case "${1:-help}" in
    list)
        echo "All workflows:"
        docker exec "$CONTAINER" n8n list:workflow
        ;;

    list-active)
        echo "Active workflows:"
        docker exec "$CONTAINER" n8n list:workflow --active=true
        ;;

    export)
        if [[ -z "${2:-}" || -z "${3:-}" ]]; then
            echo "Usage: $0 export <workflow-id> <output-file.json>"
            exit 1
        fi
        WORKFLOW_ID="$2"
        OUTPUT_FILE="$3"

        docker exec "$CONTAINER" n8n export:workflow --id="$WORKFLOW_ID" --output=/tmp/export.json
        docker cp "$CONTAINER:/tmp/export.json" "$OUTPUT_FILE"
        echo "Exported workflow $WORKFLOW_ID to $OUTPUT_FILE"
        ;;

    import)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 import <workflow-file.json>"
            exit 1
        fi
        INPUT_FILE="$2"

        if [[ ! -f "$INPUT_FILE" ]]; then
            echo "Error: File not found: $INPUT_FILE"
            exit 1
        fi

        # Check if file has an ID (will update) or not (will create)
        if grep -q '"id"' "$INPUT_FILE"; then
            echo "Importing workflow (will update if ID exists)..."
        else
            echo "Warning: No 'id' field found - this will CREATE a new workflow"
            echo "To UPDATE an existing workflow, export it first to get the ID"
        fi

        docker cp "$INPUT_FILE" "$CONTAINER:/tmp/import.json"
        docker exec "$CONTAINER" n8n import:workflow --input=/tmp/import.json
        echo "Import complete. Restarting n8n..."
        docker restart "$CONTAINER"
        echo "Done."
        ;;

    delete)
        shift
        if [[ $# -eq 0 ]]; then
            echo "Usage: $0 delete <workflow-id> [workflow-id2...]"
            exit 1
        fi

        for id in "$@"; do
            result=$(api_request DELETE "/api/v1/workflows/$id" 2>&1) && \
                echo "✓ Deleted: $id" || \
                echo "✗ Failed to delete $id: $result"
        done
        ;;

    activate)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 activate <workflow-id>"
            exit 1
        fi
        api_request PATCH "/api/v1/workflows/$2" '{"active":true}' > /dev/null && \
            echo "✓ Activated: $2" || \
            echo "✗ Failed to activate $2"
        ;;

    deactivate)
        if [[ -z "${2:-}" ]]; then
            echo "Usage: $0 deactivate <workflow-id>"
            exit 1
        fi
        api_request PATCH "/api/v1/workflows/$2" '{"active":false}' > /dev/null && \
            echo "✓ Deactivated: $2" || \
            echo "✗ Failed to deactivate $2"
        ;;

    help|--help|-h|*)
        cat << 'EOF'
n8n Workflow Management Script

Usage: ./n8n-workflow.sh <command> [args]

Commands:
  list                    List all workflows (ID|Name format)
  list-active             List only active workflows
  export <id> <file>      Export workflow to local JSON file
  import <file>           Import/update workflow from JSON file
                          (overwrites existing if JSON contains matching ID)
  delete <id> [id2...]    Delete workflow(s) by ID
  activate <id>           Activate a workflow
  deactivate <id>         Deactivate a workflow

Examples:
  ./n8n-workflow.sh list
  ./n8n-workflow.sh export ZIhqLsxBzrUam8bi ./workflows/ingestion.json
  ./n8n-workflow.sh import ./workflows/ingestion.json
  ./n8n-workflow.sh delete abc123 def456

Note: API key is read from N8N_API_KEY env var or ../.env file
EOF
        ;;
esac
