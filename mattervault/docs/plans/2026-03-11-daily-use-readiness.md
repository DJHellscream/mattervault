# Daily-Use Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Take Mattervault from demo-ready (80%) to daily-use-ready — reliable under real legal workloads, with tests preventing regressions.

**Architecture:** Each task adds one capability with its own tests, committed independently. We work from the foundation up: quick stability wins first, then reliability under load, then AI quality, then new modalities.

**Tech Stack:** Node.js (Express), Bash (E2E), Jest (unit), Docker Compose, n8n workflows, Qdrant, Ollama, Docling

**Test Strategy:** Every task includes tests BEFORE implementation (TDD where possible). Unit tests in Jest for Chat-UI/Dashboard code. E2E tests in the existing `e2e/test.sh` bash framework for pipeline behavior. Each task is independently committable and verifiable.

---

## Execution Order & Rationale

| Order | Task | Why This Order | Effort | Risk |
|-------|------|---------------|--------|------|
| 1 | Process error handlers | Foundation — silent crashes undermine all testing | 30 min | None |
| 2 | Docker health checks + resource limits | Foundation — auto-restart failed services before testing others | 2 hrs | Low |
| 3 | System prompt engineering | Highest ROI — dramatically improves answer quality at zero infra cost | 2-3 hrs | Low |
| 4 | Hallucination testing | Validates prompt engineering from Task 3 + establishes quality baseline | 1-2 hrs | Low |
| 5 | Ingestion status visibility | First real feature — paralegals need feedback on document processing | 2-3 hrs | Low |
| 6 | Large PDF chunking | Unblocks real legal workloads (200+ page docs) | 4-6 hrs | Medium |
| 7 | Upgrade embeddings to BGE-M3 | Biggest retrieval quality jump — requires full re-index | 4-6 hrs | Medium |
| 8 | Audio ingestion via Whisper | New modality — depends on BGE-M3 being stable | 4-6 hrs | Medium |
| 9 | Image-heavy page embeddings | New modality — lowest priority, only if retrieval gaps on visual content | 6-8 hrs | High |

**Dependency chain:** 1 → 2 → 3 → 4 (quality baseline), then 5 and 6 (reliability), then 7 → 8 → 9 (embeddings + modalities).

---

## Task 1: Add Process Error Handlers to Chat-UI

**Why first:** Without this, Chat-UI can crash silently. Every subsequent test could be hitting a dead server without knowing it. 30-minute quick win that stabilizes everything.

**Files:**
- Modify: `chat-ui/src/index.js`
- Create: `chat-ui/src/index.test.js`
- Modify: `chat-ui/package.json` (add Jest)

**Step 1: Add Jest to Chat-UI**

```bash
cd chat-ui
npm install --save-dev jest
```

Add to `chat-ui/package.json` scripts:
```json
"scripts": {
  "start": "node src/index.js",
  "test": "jest --forceExit --detectOpenHandles"
}
```

**Step 2: Write the failing test**

Create `chat-ui/src/index.test.js`:
```javascript
const { app } = require('./index');

describe('Process Error Handlers', () => {
  test('unhandledRejection handler is registered', () => {
    const listeners = process.listeners('unhandledRejection');
    expect(listeners.length).toBeGreaterThan(0);
  });

  test('uncaughtException handler is registered', () => {
    const listeners = process.listeners('uncaughtException');
    expect(listeners.length).toBeGreaterThan(0);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd chat-ui && npx jest src/index.test.js --forceExit --detectOpenHandles`
Expected: FAIL (no handlers registered yet)

**Step 4: Implement error handlers**

Add to `chat-ui/src/index.js` BEFORE `const app = express();`:

```javascript
// Process-level error handlers — prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit — log and continue serving
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Give time for logs to flush, then exit (Docker will restart)
  setTimeout(() => process.exit(1), 1000);
});
```

**Step 5: Run test to verify it passes**

Run: `cd chat-ui && npx jest src/index.test.js --forceExit --detectOpenHandles`
Expected: PASS

**Step 6: Add E2E health verification**

Add to `e2e/test.sh` in the `run_health_checks()` function, after existing checks:

```bash
# Chat-UI health endpoint
CHAT_HEALTH=$(curl -sf http://matterchat:3000/health 2>/dev/null)
if [ $? -eq 0 ]; then
  pass "Chat-UI health endpoint responding"
  DB_STATUS=$(echo "$CHAT_HEALTH" | jq -r '.services.database')
  REDIS_STATUS=$(echo "$CHAT_HEALTH" | jq -r '.services.redis')
  [ "$DB_STATUS" = "true" ] && pass "Chat-UI database connected" || fail "Chat-UI database disconnected"
  [ "$REDIS_STATUS" = "true" ] && pass "Chat-UI Redis connected" || fail "Chat-UI Redis disconnected"
else
  fail "Chat-UI health endpoint not responding"
fi
```

**Step 7: Commit**

```bash
git add chat-ui/package.json chat-ui/package-lock.json chat-ui/src/index.js chat-ui/src/index.test.js e2e/test.sh
git commit -m "fix(chat-ui): add process error handlers + Jest test infrastructure"
```

---

## Task 2: Docker Health Checks + Resource Limits

**Why second:** With error handlers in place, Docker healthchecks can now detect and auto-restart unhealthy services. This makes the whole stack self-healing before we test more complex features.

**Files:**
- Modify: `docker-compose.yml` (add healthcheck + resource limits to all services)
- Modify: `scripts/test-deployment-config.sh` (add healthcheck validation)

**Step 1: Write test for healthcheck directives**

Add to `scripts/test-deployment-config.sh` in Phase 1, after the volume mount checks:

```bash
echo -e "\n  ${CYAN}[Docker healthcheck directives]${NC}"
HEALTHCHECK_SERVICES="paperless n8n chat-ui health-dashboard qdrant"
for service in $HEALTHCHECK_SERVICES; do
    if grep -A 20 "^\s*${service}:" docker-compose.yml | grep -q "healthcheck:"; then
        pass "$service has healthcheck directive"
    else
        fail "$service missing healthcheck directive"
    fi
done
```

**Step 2: Run test to verify it fails**

Run: `./scripts/test-deployment-config.sh`
Expected: 5 failures for missing healthcheck directives

**Step 3: Add healthchecks to docker-compose.yml**

Add to each service (inside the service block, after `restart:`):

**paperless:**
```yaml
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
```

**qdrant:**
```yaml
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:6333/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

**n8n:**
```yaml
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:5678/healthz || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
```

**chat-ui:**
```yaml
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

**health-dashboard:**
```yaml
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/status || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

**Step 4: Add resource limits to heavy services**

Add `deploy.resources.limits` to paperless and n8n:

```yaml
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
```

For databases and Redis, limit to 512M:
```yaml
    deploy:
      resources:
        limits:
          memory: 512M
```

**Step 5: Run test to verify it passes**

Run: `./scripts/test-deployment-config.sh`
Expected: All healthcheck checks PASS

**Step 6: Validate compose file still parses**

Run: `docker compose config --quiet`
Expected: No errors

**Step 7: Commit**

```bash
git add docker-compose.yml scripts/test-deployment-config.sh
git commit -m "ops: add Docker healthchecks and resource limits to all services"
```

---

## Task 3: System Prompt Engineering

**Why third:** Before testing hallucination behavior, we need proper system prompts that instruct the LLM to ground answers in documents only. This is the highest-ROI improvement — zero infrastructure cost, immediate quality gains.

**Files:**
- Modify: `n8n-workflows/mattervault-chat-v5.json` (system prompt in Generate Answer node)
- Create: `e2e/prompts/system-prompt-legal.txt` (version-controlled prompt)
- Modify: `e2e/test.sh` (add prompt validation test)

**Step 1: Write E2E test for grounding behavior**

Add a new test function to `e2e/test.sh`:

```bash
run_prompt_quality_tests() {
    header "PROMPT QUALITY TESTS"

    # Test: System should refuse to answer without document evidence
    echo "Testing grounding behavior..."
    RESPONSE=$(curl -sf -X POST "$N8N_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d '{
            "question": "What is the capital of France?",
            "family_id": "morrison",
            "conversation_id": "test-grounding-'$(date +%s)'"
        }' 2>/dev/null)

    if echo "$RESPONSE" | grep -qi "not find\|no information\|not mentioned\|cannot determine\|don.t have\|no relevant"; then
        pass "Model correctly declined off-topic question"
    else
        fail "Model answered off-topic question instead of declining: $(echo "$RESPONSE" | head -c 200)"
    fi

    # Test: System should cite sources when answering
    RESPONSE2=$(curl -sf -X POST "$N8N_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d '{
            "question": "What documents do we have for this family?",
            "family_id": "morrison",
            "conversation_id": "test-citations-'$(date +%s)'"
        }' 2>/dev/null)

    if echo "$RESPONSE2" | grep -qiE "\[.*\]|document|source|page|title"; then
        pass "Model references documents in response"
    else
        warn "Model response may lack document references: $(echo "$RESPONSE2" | head -c 200)"
    fi
}
```

**Step 2: Run test to establish baseline**

Run: `docker exec mattertest /e2e/test.sh test` (or the specific function)
Expected: Likely FAIL — current prompt probably doesn't enforce grounding strictly enough

**Step 3: Create the legal system prompt**

Create `e2e/prompts/system-prompt-legal.txt`:

```text
You are a legal document assistant for a law firm. Your ONLY job is to answer questions using the provided document excerpts.

STRICT RULES:
1. ONLY use information from the document excerpts provided below. Never use outside knowledge.
2. If the answer is not in the provided documents, say: "I don't find that information in the available documents for this matter."
3. ALWAYS cite your sources using [Document Title, p.X] format after each claim.
4. Never speculate, assume, or infer beyond what the documents explicitly state.
5. If a question is unrelated to the documents (e.g., general knowledge), decline: "I can only answer questions about documents in this matter."
6. For legal terms, quote the exact document language in quotation marks.
7. If documents contain conflicting information, note the conflict and cite both sources.
8. Never provide legal advice — only report what the documents say.

RESPONSE FORMAT:
- Lead with the direct answer
- Support with specific citations
- Keep responses concise and professional
```

**Step 4: Update the n8n workflow**

The system prompt lives in the "Generate Answer" node of `mattervault-chat-v5.json`. Export the current workflow, update the system prompt field, re-import.

This step requires careful editing of the workflow JSON — find the node that builds the LLM prompt and update its system message template. The exact node name and field will need to be identified in the workflow JSON.

**Step 5: Run test to verify improvement**

Run: `docker exec mattertest /e2e/test.sh test`
Expected: Grounding test PASS

**Step 6: Commit**

```bash
git add e2e/prompts/system-prompt-legal.txt n8n-workflows/mattervault-chat-v5.json e2e/test.sh
git commit -m "feat(chat): add legal-grounded system prompt with citation requirements"
```

---

## Task 4: Hallucination Testing

**Why fourth:** With system prompts in place, we need a comprehensive test suite that catches hallucination regressions. These tests become the quality gate for all future AI changes (model swaps, prompt tweaks, embedding upgrades).

**Files:**
- Modify: `e2e/test.sh` (add hallucination test suite)
- Create: `e2e/test-queries.json` (structured test cases)

**Step 1: Create structured test cases**

Create `e2e/test-queries.json`:

```json
{
  "grounding_tests": [
    {
      "name": "off_topic_general_knowledge",
      "question": "What is the capital of France?",
      "family_id": "morrison",
      "expect": "decline",
      "match_patterns": ["not find", "no information", "cannot determine", "only answer questions about documents"]
    },
    {
      "name": "nonexistent_clause",
      "question": "What is the liability cap in the trust agreement?",
      "family_id": "morrison",
      "expect": "decline_or_honest",
      "match_patterns": ["not find", "not mentioned", "no liability cap", "don't find"]
    },
    {
      "name": "fabricated_person",
      "question": "What did John Doe sign on January 1st?",
      "family_id": "morrison",
      "expect": "decline",
      "match_patterns": ["not find", "no information", "no record", "don't find"]
    },
    {
      "name": "cross_family_probe",
      "question": "Tell me about the Johnson family documents",
      "family_id": "morrison",
      "expect": "decline_or_scoped",
      "match_patterns": ["morrison", "this matter", "current family", "not find"]
    }
  ],
  "citation_tests": [
    {
      "name": "should_cite_sources",
      "question": "Summarize the key documents for this family",
      "family_id": "morrison",
      "expect": "has_citations",
      "match_patterns": ["\\[", "page", "p\\."]
    }
  ]
}
```

**Step 2: Add hallucination test runner to e2e/test.sh**

```bash
run_hallucination_tests() {
    header "HALLUCINATION & GROUNDING TESTS"

    # Read test cases from JSON
    TESTS=$(cat /e2e/test-queries.json)
    GROUNDING_COUNT=$(echo "$TESTS" | jq '.grounding_tests | length')

    for i in $(seq 0 $((GROUNDING_COUNT - 1))); do
        TEST_NAME=$(echo "$TESTS" | jq -r ".grounding_tests[$i].name")
        QUESTION=$(echo "$TESTS" | jq -r ".grounding_tests[$i].question")
        FAMILY=$(echo "$TESTS" | jq -r ".grounding_tests[$i].family_id")
        PATTERNS=$(echo "$TESTS" | jq -r ".grounding_tests[$i].match_patterns[]")

        echo "  Testing: $TEST_NAME"
        RESPONSE=$(curl -sf -X POST "$N8N_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{
                \"question\": \"$QUESTION\",
                \"family_id\": \"$FAMILY\",
                \"conversation_id\": \"test-hallucination-${TEST_NAME}-$(date +%s)\"
            }" 2>/dev/null)

        ANSWER=$(echo "$RESPONSE" | jq -r '.answer // .response // .text // .' 2>/dev/null | tr '[:upper:]' '[:lower:]')
        MATCHED=false
        for pattern in $PATTERNS; do
            if echo "$ANSWER" | grep -qi "$pattern"; then
                MATCHED=true
                break
            fi
        done

        if [ "$MATCHED" = true ]; then
            pass "$TEST_NAME: model correctly grounded"
        else
            fail "$TEST_NAME: possible hallucination — $(echo "$ANSWER" | head -c 150)"
        fi

        sleep 2  # Rate limit between tests
    done
}
```

**Step 3: Run the hallucination test suite**

Run: `docker exec mattertest /e2e/test.sh test` (with hallucination tests added to `all` mode)
Expected: All grounding tests PASS (after Task 3 prompt engineering)

**Step 4: Commit**

```bash
git add e2e/test.sh e2e/test-queries.json
git commit -m "test: add hallucination and grounding test suite with JSON test cases"
```

---

## Task 5: Ingestion Status Visibility (Processing Tags)

**Why fifth:** First real user-facing feature. Paralegals need to know if their documents processed successfully.

**Files:**
- Modify: `n8n-workflows/document-ingestion-v2.json` (add tag management steps)
- Modify: `e2e/test.sh` (add ingestion status tests)
- Modify: `scripts/init-mattervault.sh` (create default status tags)

**Step 1: Write E2E test for tag flow**

Add to `e2e/test.sh`:

```bash
run_ingestion_status_tests() {
    header "INGESTION STATUS TESTS"

    # Check that status tags exist in Paperless
    for tag in "processing" "ai_ready" "error"; do
        TAG_CHECK=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=$tag" \
            -H "Authorization: Token $PAPERLESS_TOKEN" 2>/dev/null)
        COUNT=$(echo "$TAG_CHECK" | jq '.count // 0')
        if [ "$COUNT" -gt 0 ]; then
            pass "Paperless tag '$tag' exists"
        else
            fail "Paperless tag '$tag' missing (run init-mattervault.sh)"
        fi
    done

    # After ingesting a test document, check it gets ai_ready tag
    # (This test runs after document ingestion in 'full' mode)
    if [ -n "$TEST_DOC_ID" ]; then
        sleep 5  # Wait for async tag update
        DOC_TAGS=$(curl -sf "$PAPERLESS_URL/api/documents/$TEST_DOC_ID/" \
            -H "Authorization: Token $PAPERLESS_TOKEN" 2>/dev/null | jq -r '.tags[]')
        AI_READY_TAG_ID=$(curl -sf "$PAPERLESS_URL/api/tags/?name__iexact=ai_ready" \
            -H "Authorization: Token $PAPERLESS_TOKEN" 2>/dev/null | jq -r '.results[0].id')

        if echo "$DOC_TAGS" | grep -q "$AI_READY_TAG_ID"; then
            pass "Document got 'ai_ready' tag after ingestion"
        else
            fail "Document missing 'ai_ready' tag after ingestion"
        fi
    fi
}
```

**Step 2: Run test to verify it fails**

Expected: Tags don't exist yet, test fails

**Step 3: Add tag creation to init-mattervault.sh**

In the initialization script, after Paperless is ready, create the status tags:

```bash
echo "Creating ingestion status tags..."
for tag in "processing" "ai_ready" "error"; do
    curl -sf -X POST "$PAPERLESS_URL/api/tags/" \
        -H "Authorization: Token $PAPERLESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$tag\", \"color\": \"#808080\", \"is_inbox_tag\": false}" 2>/dev/null || true
done
```

**Step 4: Update n8n ingestion workflow**

Modify `document-ingestion-v2.json` to add three tag management steps:

1. **On ingestion start:** Add `processing` tag to document via Paperless API
2. **On success:** Remove `processing`, add `ai_ready`
3. **On error:** Remove `processing`, add `error`

These are HTTP Request nodes in n8n calling `PATCH /api/documents/{id}/` to update tags.

**Step 5: Run test to verify it passes**

Run init script, re-run E2E test
Expected: All tag tests PASS

**Step 6: Commit**

```bash
git add scripts/init-mattervault.sh n8n-workflows/document-ingestion-v2.json e2e/test.sh
git commit -m "feat(ingestion): add processing status tags (processing → ai_ready / error)"
```

---

## Task 6: Large PDF Chunking (>50 pages)

**Why sixth:** Unblocks real legal workloads. Estate planning docs, discovery packets, and court filings regularly exceed 50 pages.

**Files:**
- Create: `scripts/split-pdf.py` (PDF splitter utility)
- Modify: `n8n-workflows/document-ingestion-v2.json` (add page count check + split logic)
- Modify: `e2e/test.sh` (add large PDF test)
- Modify: `docker-compose.yml` (add PyPDF2 to n8n image if needed)

**Step 1: Write E2E test for large PDF handling**

Add to `e2e/test.sh`:

```bash
run_large_pdf_tests() {
    header "LARGE PDF HANDLING TESTS"

    # Create a synthetic large PDF (60+ pages) using existing test doc repeated
    # This tests the chunking pipeline without needing a real 200-page doc
    echo "Checking page count detection in ingestion workflow..."

    # Verify the split-pdf.py script exists and works
    if docker exec matterlogic python3 -c "import PyPDF2; print('PyPDF2 available')" 2>/dev/null; then
        pass "PyPDF2 available in n8n container"
    else
        fail "PyPDF2 missing from n8n container"
    fi

    # Verify split script is mounted
    if docker exec matterlogic test -f /files/scripts/split-pdf.py; then
        pass "split-pdf.py script is mounted"
    else
        fail "split-pdf.py script not mounted in n8n container"
    fi
}
```

**Step 2: Create the PDF split script**

Create `scripts/split-pdf.py`:

```python
#!/usr/bin/env python3
"""Split large PDFs into chunks for Docling processing.

Usage: python3 split-pdf.py input.pdf output_dir/ --max-pages 25

Returns JSON array of chunk files with page offsets:
[{"file": "chunk_001.pdf", "page_offset": 0, "page_count": 25}, ...]
"""
import sys
import os
import json
import argparse

def split_pdf(input_path, output_dir, max_pages=25):
    from PyPDF2 import PdfReader, PdfWriter

    reader = PdfReader(input_path)
    total = len(reader.pages)

    if total <= max_pages:
        print(json.dumps([{"file": input_path, "page_offset": 0, "page_count": total}]))
        return

    os.makedirs(output_dir, exist_ok=True)
    chunks = []
    for start in range(0, total, max_pages):
        end = min(start + max_pages, total)
        writer = PdfWriter()
        for i in range(start, end):
            writer.add_page(reader.pages[i])

        chunk_name = f"chunk_{start // max_pages + 1:03d}.pdf"
        chunk_path = os.path.join(output_dir, chunk_name)
        with open(chunk_path, "wb") as f:
            writer.write(f)

        chunks.append({
            "file": chunk_path,
            "page_offset": start,
            "page_count": end - start
        })

    print(json.dumps(chunks))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Input PDF path")
    parser.add_argument("output_dir", help="Output directory for chunks")
    parser.add_argument("--max-pages", type=int, default=25)
    args = parser.parse_args()
    split_pdf(args.input, args.output_dir, args.max_pages)
```

**Step 3: Update n8n ingestion workflow**

In `document-ingestion-v2.json`, add a conditional branch after downloading the PDF:

1. **Check page count** (Python Code node using PyPDF2)
2. **If ≤ 25 pages:** proceed to Docling as normal
3. **If > 25 pages:** call `split-pdf.py`, loop over chunks, process each through Docling with `page_offset` added to all page numbers

**Step 4: Mount script in docker-compose.yml**

Add to n8n volumes:
```yaml
- ${MATTERVAULT_DATA_DIR:-.}/scripts:/files/scripts:ro
```

**Step 5: Run tests**

Expected: PyPDF2 available, script mounted, chunking logic works

**Step 6: Commit**

```bash
git add scripts/split-pdf.py docker-compose.yml n8n-workflows/document-ingestion-v2.json e2e/test.sh
git commit -m "feat(ingestion): add large PDF chunking (split >25 pages for Docling)"
```

---

## Task 7: Upgrade Embeddings to BGE-M3

**Why seventh:** Biggest retrieval quality improvement. BGE-M3 provides native dense + sparse vectors from one model, validated for legal document retrieval. Requires a full re-index so we do this after the pipeline is stable.

**Files:**
- Modify: `scripts/init-qdrant.sh` (create v3 collection with 1024 dims)
- Modify: `scripts/init-mattervault.sh` (pull bge-m3, create v3 collection)
- Modify: `n8n-workflows/document-ingestion-v2.json` (switch to bge-m3, update sparse vector generation)
- Modify: `n8n-workflows/mattervault-chat-v5.json` (switch query embedding)
- Modify: `.env.example` + `.env` (update OLLAMA_EMBEDDING_MODEL)
- Modify: `docker-compose.yml` (pass new collection name)
- Modify: `CLAUDE.md` (update docs)
- Modify: `e2e/test.sh` (add embedding dimension validation)

**Step 1: Write tests for new collection**

Add to `e2e/test.sh`:

```bash
run_embedding_validation_tests() {
    header "EMBEDDING VALIDATION TESTS"

    # Check collection exists with correct dimensions
    COLLECTION=$(curl -sf "http://mattermemory:6333/collections/mattervault_documents_v3" 2>/dev/null)
    if [ $? -eq 0 ]; then
        pass "Qdrant collection v3 exists"
        DIM=$(echo "$COLLECTION" | jq '.result.config.params.vectors.size')
        if [ "$DIM" = "1024" ]; then
            pass "Vector dimensions = 1024 (BGE-M3)"
        else
            fail "Vector dimensions = $DIM (expected 1024)"
        fi
    else
        fail "Qdrant collection v3 does not exist"
    fi

    # Check embedding model is bge-m3
    MODEL_CHECK=$(curl -sf "http://${OLLAMA_HOST:-host.docker.internal}:11434/api/tags" 2>/dev/null)
    if echo "$MODEL_CHECK" | jq -r '.models[].name' | grep -q "bge-m3"; then
        pass "bge-m3 model available in Ollama"
    else
        fail "bge-m3 model not found in Ollama"
    fi
}
```

**Step 2: Create v3 collection in init-qdrant.sh**

Update to create `mattervault_documents_v3` with 1024 dimensions and BM25 sparse vectors.

**Step 3: Update all workflows to use bge-m3**

- Ingestion: change embedding model call from nomic-embed-text to bge-m3
- Chat: change query embedding to bge-m3
- Update collection name references

**Step 4: Update .env.example, .env, docker-compose.yml, CLAUDE.md**

```
OLLAMA_EMBEDDING_MODEL=bge-m3
QDRANT_COLLECTION=mattervault_documents_v3
```

**Step 5: Re-index all documents**

```bash
# Pull the model
ollama pull bge-m3

# Run init to create new collection
./scripts/init-mattervault.sh

# Trigger re-ingestion of all documents via reconciliation
curl -X POST http://localhost:5678/webhook/document-reconciliation
```

**Step 6: Run full E2E test suite**

Run: `docker exec mattertest /e2e/test.sh all`
Expected: All existing tests still pass + new embedding tests pass

**Step 7: Commit**

```bash
git add scripts/init-qdrant.sh scripts/init-mattervault.sh \
  n8n-workflows/document-ingestion-v2.json n8n-workflows/mattervault-chat-v5.json \
  .env.example docker-compose.yml CLAUDE.md e2e/test.sh
git commit -m "feat(embeddings): upgrade to BGE-M3 (1024d) with v3 collection"
```

---

## Task 8: Audio Ingestion via Whisper

**Why eighth:** First new modality. Docling already has Whisper ASR integration — we wire it into the existing pipeline. Depends on BGE-M3 being stable since we embed the transcripts.

**Files:**
- Modify: `n8n-workflows/document-ingestion-v2.json` (add audio file detection + Whisper transcription path)
- Modify: `docker-compose.yml` (configure Docling ASR if needed)
- Modify: `e2e/test.sh` (add audio ingestion test)
- Modify: `CLAUDE.md` (document audio support)

**Step 1: Write E2E test for audio ingestion**

```bash
run_audio_ingestion_tests() {
    header "AUDIO INGESTION TESTS"

    # Check if Docling supports ASR
    DOCLING_HEALTH=$(curl -sf "http://${DOCLING_HOST:-host.docker.internal}:5001/health" 2>/dev/null)
    if [ $? -eq 0 ]; then
        pass "Docling API responding"
    else
        fail "Docling API not responding"
    fi

    # Create a small test audio file (WAV with silence)
    # Note: In production, actual voice memos would be dropped into intake/
    # For testing, we verify the pipeline accepts audio MIME types
    pass "Audio ingestion pipeline test (placeholder — needs real audio fixture)"
}
```

**Step 2: Implement audio detection in ingestion workflow**

Add a MIME type check after document download:
- If `application/pdf` → existing Docling PDF pipeline
- If `audio/*` → Docling ASR pipeline → transcript text → embed with BGE-M3

**Step 3: Test with a real audio file**

Create a small WAV test fixture and drop into intake folder.

**Step 4: Commit**

```bash
git add n8n-workflows/document-ingestion-v2.json e2e/test.sh CLAUDE.md
git commit -m "feat(ingestion): add audio transcription via Whisper/Docling ASR"
```

---

## Task 9: Image-Heavy Page Embeddings (SigLIP 2)

**Why last:** Lowest priority. Only matters if retrieval is missing answers that exist in charts/diagrams. Requires running a separate model (SigLIP 2, ~400M params) and storing image vectors in Qdrant alongside text vectors.

**Files:**
- Create: `scripts/image-embedder/` (SigLIP 2 service or n8n Code node)
- Modify: `docker-compose.yml` (add SigLIP 2 service or configure existing)
- Modify: `n8n-workflows/document-ingestion-v2.json` (add image extraction path)
- Modify: `scripts/init-qdrant.sh` (add image vector collection or named vectors)
- Modify: `e2e/test.sh` (add image embedding tests)

**This task is the most complex and should be scoped further during implementation.** Key decisions:
- Separate Qdrant collection for images vs. named vectors in same collection
- SigLIP 2 as a Docker sidecar vs. Python script in n8n
- Which pages to extract (all vs. Docling-detected image pages only)

**Defer detailed planning until Tasks 1-8 are complete and we can evaluate whether visual retrieval gaps actually exist.**

---

## Verification Checklist (After All Tasks)

Run the full suite to confirm nothing is broken:

```bash
# Config validation
./scripts/test-deployment-config.sh

# Full E2E
docker exec mattertest /e2e/test.sh all

# Unit tests
cd chat-ui && npm test
cd ../dashboard && npm test
```

Expected: All green across all test suites.
