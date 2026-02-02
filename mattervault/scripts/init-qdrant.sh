#!/usr/bin/env bash
# ==============================================================================
# Initialize Qdrant Collection for Mattervault (V2 Hybrid Schema)
# Creates the mattervault_documents_v2 collection with dense + sparse vectors
# Usage: ./scripts/init-qdrant.sh
# ==============================================================================
set -euo pipefail

QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"
COLLECTION_NAME="mattervault_documents_v2"

echo "=============================================="
echo "  Mattervault Qdrant Collection Setup (V2)"
echo "=============================================="
echo ""
echo "Qdrant URL: $QDRANT_URL"
echo "Collection: $COLLECTION_NAME"
echo ""

# Check if Qdrant is reachable
echo "Checking Qdrant connectivity..."
if ! curl -sf "$QDRANT_URL/collections" >/dev/null 2>&1; then
    echo "ERROR: Cannot connect to Qdrant at $QDRANT_URL"
    exit 1
fi
echo "Qdrant is reachable."
echo ""

# Check if collection already exists
echo "Checking if collection exists..."
EXISTS=$(curl -sf "$QDRANT_URL/collections/$COLLECTION_NAME" 2>/dev/null | grep -q "points_count" && echo "YES" || echo "NO")

if [ "$EXISTS" = "NO" ]; then
    echo "Collection does not exist. Creating V2 hybrid collection..."

    # Create collection with hybrid vector config:
    # - Dense: 768 dims for nomic-embed-text
    # - Sparse: BM25 with IDF modifier
    curl -sf -X PUT "$QDRANT_URL/collections/$COLLECTION_NAME" \
        -H "Content-Type: application/json" \
        -d '{
            "vectors": {
                "dense": {
                    "size": 768,
                    "distance": "Cosine"
                }
            },
            "sparse_vectors": {
                "bm25": {
                    "modifier": "idf"
                }
            }
        }' || { echo "ERROR: Failed to create collection"; exit 1; }

    echo "Collection created successfully!"
    echo ""

    # Create payload indexes for efficient filtering
    echo "Creating payload indexes..."

    # Index for family_id (CRITICAL for multi-tenancy isolation)
    curl -sf -X PUT "$QDRANT_URL/collections/$COLLECTION_NAME/index" \
        -H "Content-Type: application/json" \
        -d '{
            "field_name": "family_id",
            "field_schema": "keyword"
        }' >/dev/null 2>&1 && echo "  ✓ family_id index" || echo "  ⚠ family_id index (may exist)"

    # Index for document_id (for document-level operations like delete)
    curl -sf -X PUT "$QDRANT_URL/collections/$COLLECTION_NAME/index" \
        -H "Content-Type: application/json" \
        -d '{
            "field_name": "document_id",
            "field_schema": "keyword"
        }' >/dev/null 2>&1 && echo "  ✓ document_id index" || echo "  ⚠ document_id index (may exist)"

    echo ""
    echo "Indexes created!"

else
    echo "Collection already exists."
fi

echo ""
echo "=============================================="
echo "Verifying collection..."

# Get collection info
INFO=$(curl -sf "$QDRANT_URL/collections/$COLLECTION_NAME")
POINTS=$(echo "$INFO" | grep -o '"points_count":[0-9]*' | cut -d: -f2)
echo "  Points count: ${POINTS:-0}"

echo ""
echo "=============================================="
echo "Setup complete!"
echo ""
echo "Collection schema (V2 Hybrid):"
echo "  - Dense vectors: 768 dimensions (nomic-embed-text), Cosine"
echo "  - Sparse vectors: BM25 with IDF modifier"
echo "  - Indexed fields: family_id, document_id"
echo ""
echo "Required payload fields per vector:"
echo "  - family_id: string (REQUIRED - tenant isolation)"
echo "  - document_id: string (Paperless document ID)"
echo "  - document_title: string"
echo "  - text: string (chunk text for search)"
echo "  - context_text: string (parent chunk for retrieval)"
echo "  - page_num: integer"
echo "  - chunk_index: integer"
echo "=============================================="
