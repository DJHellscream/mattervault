# Phase 2: Chat Query Pipeline (Production-Grade)

> **Status:** COMPLETE (2026-01-27)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a production-quality legal document retrieval system with hybrid search and cross-encoder reranking for maximum accuracy.

---

## Architecture Decision: HTTP Requests vs Native Nodes

**Decision:** Use HTTP Request nodes (not native Qdrant Vector Store nodes)

| Factor | HTTP Requests | Native Qdrant Nodes |
|--------|---------------|---------------------|
| Schema flexibility | Our custom format works | Requires LangChain format |
| Hybrid search (BM25) | Full Query API access | Not supported |
| RRF fusion | Yes | Not available |
| Cross-encoder reranking | Custom implementation | Not available |
| Debugging | Explicit JSON visible | Black box |

**Rationale:** Legal document retrieval requires maximum accuracy. Native nodes don't support hybrid search or advanced reranking. HTTP requests give us full control over Qdrant's Query API.

---

## Production Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CHAT QUERY PIPELINE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User Question                                                              │
│       ↓                                                                     │
│  ┌─────────────────┐                                                        │
│  │ Embed Question  │ ← Ollama (nomic-embed-text) → Dense Vector             │
│  └────────┬────────┘                                                        │
│           ↓                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                    HYBRID SEARCH (Qdrant)                       │        │
│  │  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐        │        │
│  │  │Dense Search │     │ BM25 Sparse │     │  RRF Fusion │        │        │
│  │  │ (semantic)  │  +  │  (keyword)  │  →  │ (combine)   │        │        │
│  │  └─────────────┘     └─────────────┘     └─────────────┘        │        │
│  │                                                                 │        │
│  │  Filter: family_id = "morrison"                                 │        │
│  │  Output: Top 25 candidates                                      │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│           ↓                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐        │
│  │                 CROSS-ENCODER RERANKING                         │        │
│  │                                                                 │        │
│  │  Model: Qwen3-Reranker (via Ollama)                             │        │
│  │  Input: Query + 25 candidates                                   │        │
│  │  Output: Top 5 most relevant                                    │        │
│  └─────────────────────────────────────────────────────────────────┘        │
│           ↓                                                                 │
│  ┌─────────────────┐                                                        │
│  │ Build Context   │ ← Parent chunks (context_text) with citations          │
│  └────────┬────────┘                                                        │
│           ↓                                                                 │
│  ┌─────────────────┐                                                        │
│  │ Generate Answer │ ← Ollama (llama3.1:8b) with legal constraints          │
│  └────────┬────────┘                                                        │
│           ↓                                                                 │
│  Response with Citations                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Why Hybrid Search Matters for Legal Documents

| Search Type | Catches | Example |
|-------------|---------|---------|
| Dense (semantic) | Conceptual meaning | "estate distribution" ↔ "inheritance allocation" |
| Sparse (BM25) | Exact terms | "Section 2.1(a)", "Form 1040", "Article IV" |
| **Hybrid (RRF)** | **Both** | Legal citations AND semantic concepts |

Pure semantic search might miss "Section 2.1(a)" because it's not semantically meaningful. BM25 catches it exactly.

---

## Prerequisites

### Models to Install

```bash
# On Windows host with Ollama
ollama pull nomic-embed-text          # Dense embeddings (768 dims)
ollama pull dengcao/Qwen3-Reranker-0.6B  # Cross-encoder reranker
ollama pull llama3.1:8b               # Response generation
```

### Qdrant Collection Update

Current collection only has dense vectors. We need to add sparse vectors for BM25.

---

## Task 1: Update Qdrant Collection for Hybrid Search

**Context:** Add sparse vector support to existing collection for BM25 keyword search.

**Step 1: Check current collection config**

```bash
curl http://localhost:6333/collections/mattervault_documents
```

**Step 2: Create new collection with hybrid support**

Since Qdrant doesn't allow adding sparse vectors to existing collections, we need to:
1. Create new collection `mattervault_documents_v2` with both vector types
2. Migrate existing data
3. Rename collections

```bash
curl -X PUT "http://localhost:6333/collections/mattervault_documents_v2" \
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
  }'
```

**Step 3: Update ingestion workflow to generate sparse vectors**

The ingestion pipeline needs to:
1. Generate dense embedding (nomic-embed-text) - already done
2. Generate BM25 sparse vector for each chunk - NEW

**Note:** Qdrant can compute BM25 internally if we use their text indexing, OR we can use a tokenizer. For simplicity, we'll use Qdrant's built-in BM25 with text field indexing.

---

## Task 2: Update Ingestion for Hybrid Vectors

**Context:** Modify Document Ingestion Pipeline to store both dense and sparse vectors.

**Step 1: Update "Prepare Qdrant Payload" node**

Add sparse vector generation using simple tokenization:

```javascript
// Generate BM25-compatible sparse vector
const text = $json.text.toLowerCase();
const words = text.split(/\W+/).filter(w => w.length > 2);
const wordCounts = {};
words.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });

// Convert to sparse format: {indices: [], values: []}
const indices = [];
const values = [];
Object.entries(wordCounts).forEach(([word, count], idx) => {
  indices.push(hashCode(word) % 30000);  // Hash to fixed vocab size
  values.push(count);
});

return {
  ...previousData,
  sparse_vector: { indices, values }
};
```

**Step 2: Update "Store in Qdrant" node**

Change to use named vectors:

```json
{
  "points": [{
    "id": {{ $json.point_id }},
    "vector": {
      "dense": {{ $json.dense_vector }},
      "bm25": {{ $json.sparse_vector }}
    },
    "payload": {{ $json.payload }}
  }]
}
```

**Step 3: Re-index existing documents**

After updating ingestion, re-process the Morrison Family Profile document.

---

## Task 3: Implement Hybrid Search in Chat Workflow

**Context:** Use Qdrant's Query API with RRF fusion for hybrid search.

**Step 1: Update search to use Query API**

Replace simple search with prefetch + fusion:

```json
{
  "prefetch": [
    {
      "query": {{ $json.question_vector }},
      "using": "dense",
      "limit": 25,
      "filter": {
        "must": [{"key": "family_id", "match": {"value": "{{ $json.family_id }}"}}]
      }
    },
    {
      "query": {
        "indices": {{ $json.question_sparse.indices }},
        "values": {{ $json.question_sparse.values }}
      },
      "using": "bm25",
      "limit": 25,
      "filter": {
        "must": [{"key": "family_id", "match": {"value": "{{ $json.family_id }}"}}]
      }
    }
  ],
  "query": {"fusion": "rrf"},
  "limit": 25,
  "with_payload": true
}
```

**Endpoint:** `POST /collections/mattervault_documents_v2/points/query`

**Step 2: Generate sparse vector for question**

Add tokenization for the question (same as ingestion):

```javascript
const question = $json.question.toLowerCase();
const words = question.split(/\W+/).filter(w => w.length > 2);
const wordCounts = {};
words.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });

const indices = [];
const values = [];
Object.entries(wordCounts).forEach(([word, count]) => {
  indices.push(hashCode(word) % 30000);
  values.push(count);
});

return {
  ...previousData,
  question_sparse: { indices, values }
};
```

---

## Task 4: Add Cross-Encoder Reranking

**Context:** Use Qwen3-Reranker to score query-document pairs for accurate relevance.

**Step 1: Install reranker model**

```bash
ollama pull dengcao/Qwen3-Reranker-0.6B
```

**Step 2: Add reranking node after hybrid search**

For each of the 25 results, call the reranker:

```javascript
const question = $json.question;
const results = $json.hybrid_results;

// Score each result with cross-encoder
const scored = [];
for (const result of results) {
  const prompt = `Query: ${question}\nDocument: ${result.payload.text}\n\nIs this document relevant to the query? Score from 0 to 1:`;

  // Call Ollama with reranker
  const response = await fetch('http://host.docker.internal:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: 'dengcao/Qwen3-Reranker-0.6B',
      prompt: prompt,
      stream: false
    })
  });

  const score = parseFloat(response.response) || 0;
  scored.push({ ...result, rerank_score: score });
}

// Sort and take top 5
return scored.sort((a, b) => b.rerank_score - a.rerank_score).slice(0, 5);
```

**Alternative: Batch reranking**

If individual calls are too slow, batch the reranking in a single prompt.

**Step 3: Test reranking quality**

Compare results with/without reranking to verify improvement.

---

## Task 5: Update Prompt Construction

**Context:** Build context from top 5 reranked results with proper citations.

Same as original Task 5, but now using reranked results.

---

## Task 6: Generate Response

**Context:** Use Ollama with strict legal constraints.

Same as original Task 6.

---

## Task 7: Add Error Handling

Same as original Task 7.

---

## Task 8: Export and Document

**Step 1: Export updated workflow**

Save to `n8n-workflows/mattervault-chat-hybrid.json`

**Step 2: Update CLAUDE.md**

Document the hybrid search architecture and models used.

---

## Verification Milestone

| Check | Action | Expected |
|-------|--------|----------|
| Hybrid search works | Query with legal citation | Exact match found |
| Semantic search works | Query with paraphrase | Conceptual match found |
| Reranking improves | Compare with/without | Better relevance ordering |
| Citations accurate | Check source references | Correct doc + page |
| Family isolation | Query wrong family | No results leaked |

---

## Models Summary

| Model | Purpose | Size | Location |
|-------|---------|------|----------|
| nomic-embed-text | Dense embeddings | 137M | Ollama |
| Qwen3-Reranker-0.6B | Cross-encoder reranking | 0.6B | Ollama |
| llama3.1:8b | Response generation | 8B | Ollama |

---

## Performance Considerations

| Stage | Latency | Optimization |
|-------|---------|--------------|
| Embedding | ~100ms | Single call |
| Hybrid search | ~50ms | Server-side fusion |
| Reranking (25 docs) | ~2-5s | Batch or parallel |
| Generation | ~3-10s | Depends on context size |

**Total expected:** 5-15 seconds per query

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| BM25 not matching | Sparse vectors missing | Re-index with sparse |
| Reranker timeout | Model not loaded | `ollama run dengcao/Qwen3-Reranker-0.6B` |
| RRF returns empty | Prefetch failed | Check both dense and sparse queries |
| Slow reranking | Too many candidates | Reduce prefetch limit to 15 |

---

## References

- [Qdrant Hybrid Search](https://qdrant.tech/articles/hybrid-search/)
- [Qdrant Query API](https://qdrant.tech/documentation/concepts/search/#query-api)
- [Qwen3-Reranker on Ollama](https://ollama.com/dengcao/Qwen3-Reranker-0.6B)
- [RRF Fusion Explained](https://qdrant.tech/documentation/advanced-tutorials/reranking-hybrid-search/)
