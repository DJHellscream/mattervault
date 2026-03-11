# Phase 1: Document Ingestion Pipeline

> **Status:** COMPLETE (2026-01-26)

**Goal:** Build an n8n workflow that automatically processes PDFs dropped into Paperless, extracts structured text via Docling, chunks it, embeds it, and stores vectors in Qdrant with family isolation.

**Architecture:** Paperless webhook triggers n8n → n8n fetches PDF → sends to Docling → receives Markdown → chunks with parent-child strategy → embeds via Ollama → upserts to Qdrant with family_id payload.

**Tech Stack:** n8n, Paperless-ngx API, Docling REST API, Ollama API, Qdrant REST API

---

## Completion Summary

**Verified Working:** 2026-01-26

Pipeline successfully processes documents end-to-end:
- Morrison Family Profile document → 30 chunks stored in Qdrant
- `family_id: "morrison"` correctly extracted from Paperless tags
- Parent-child structure preserved (text + context_text fields)

**Workflow File:** `n8n-workflows/document-ingestion-update.json`

**Key Implementation Details:**
1. Docling uses async endpoint `/v1/convert/file/async` with polling at `/v1/status/poll/{task_id}`
2. Point IDs are integers: `document_id * 10000 + chunk_index` (Qdrant requires int or UUID)
3. Document info (document_id, family_id, title) passed through entire polling loop because Wait node loses node references
4. Family tag validation added - documents without family tag produce explicit error

---

## Future Testing & Improvements

The following areas need additional testing and potential improvements:

| Area | Issue | Priority |
|------|-------|----------|
| **Chunking Quality** | Current strategy splits by markdown headers - may need tuning for different document types (wills vs contracts vs profiles) | High |
| **Error Handling** | Limited retry logic on transient failures (Docling timeout, Ollama unavailable, Qdrant connection) | High |
| **Large Documents** | Docling may timeout on >50 pages; need chunking at input or increased timeouts | Medium |
| **Scanned PDFs** | OCR quality depends on scan quality; need to test with actual legal documents | Medium |
| **Table Preservation** | Tables convert to markdown but may lose formatting - verify retrieval quality | Medium |
| **Re-indexing** | Document update/delete in Paperless should trigger vector cleanup in Qdrant | Low |
| **Batch Processing** | Multiple documents dropped at once may overwhelm pipeline | Low |

---

## Prerequisites

Before starting, verify:

```bash
# All services running
./scripts/health-check.sh

# Qdrant collection exists
curl http://localhost:6333/collections/mattervault_documents
```

---

## Task 1: Configure Paperless Native Webhook

**Context:** Paperless-ngx v2.0+ has built-in webhook support. We configure it to notify n8n when documents are added.

**Step 1: Create n8n workflow with Webhook trigger**

Via n8n API (automated) or manually:
- Create workflow named "Document Ingestion"
- Add Webhook node: POST, path: `document-added`
- Webhook URL: `http://matterlogic:5678/webhook/document-added`

**Step 2: Configure Paperless webhook in Admin UI**

1. Open Paperless at `http://localhost:8000/admin/`
2. Login with admin credentials
3. Navigate to: **Paperless Admin** → **Webhooks** (or Settings → Webhooks)
4. Click **Add Webhook**
5. Configure:
   - **Name:** `n8n Document Ingestion`
   - **URL:** `http://matterlogic:5678/webhook/document-added`
   - **Trigger:** `document_added` (or "Document Added")
   - **Enabled:** Yes

**Step 3: Test webhook fires**

1. Activate the n8n workflow (toggle on)
2. Drop a test PDF in `./intake/morrison/`
3. Wait for Paperless to consume (check Paperless UI)
4. Check n8n execution history - should show incoming webhook

**Webhook Payload (from Paperless):**
```json
{
  "document_id": 123,
  "document": {...},
  "tags": [...],
  "correspondent": {...},
  ...
}
```

**No commit needed** - webhook is configured in Paperless database, not files.

---

## Task 2: Fetch Document Details from Paperless API

**Context:** The webhook only gives us the document ID. We need full metadata including tags (for family_id).

**Step 1: Add HTTP Request node after Webhook**

Node settings:
- Name: "Get Document Details"
- Method: GET
- URL: `http://webserver:8000/api/documents/{{ $json.document_id }}/`
- Authentication: Header Auth
  - Name: `Authorization`
  - Value: `Token {{ $env.PAPERLESS_API_TOKEN }}`

**Step 2: Create Paperless API token**

```bash
docker exec -it mattervault python manage.py shell -c "
from rest_framework.authtoken.models import Token
from django.contrib.auth.models import User
user = User.objects.get(username='admin')
token, created = Token.objects.get_or_create(user=user)
print(f'Token: {token.key}')
"
```

Save this token to n8n credentials or environment.

**Step 3: Add Set node to extract family_id from tags**

Node settings:
- Name: "Extract Family ID"
- Mode: Manual Mapping
- Assignments:
  - `document_id` = `{{ $json.id }}`
  - `title` = `{{ $json.title }}`
  - `family_id` = `{{ $json.tags[0].name.toLowerCase() }}` (assumes first tag is family)
  - `download_url` = `http://webserver:8000{{ $json.document }}`

**Step 4: Test the flow**

1. Trigger webhook manually or drop test PDF
2. Verify "Extract Family ID" node outputs correct family_id

**Commit:**
```bash
# Export workflow from n8n UI to JSON
git add n8n-workflows/document-ingestion.json
git commit -m "feat: add document details fetch from Paperless API"
```

---

## Task 3: Download PDF and Send to Docling

**Context:** We need the actual PDF bytes to send to Docling for parsing.

**Step 1: Add HTTP Request node to download PDF**

Node settings:
- Name: "Download PDF"
- Method: GET
- URL: `{{ $json.download_url }}`
- Authentication: Header Auth (same as before)
- Response Format: File

**Step 2: Add HTTP Request node to call Docling (Async)**

> **Note:** Docling-serve uses async processing. We submit the job, then poll for completion.

Node settings for "Start Docling Conversion":
- Name: "Start Docling Conversion"
- Method: POST
- URL: `http://host.docker.internal:5001/v1/convert/file/async`
- Body Content Type: Form-Data
- Form Parameters:
  - `file` = `{{ $binary.data }}` (binary from previous node)
  - `options` = `{"do_ocr": true, "force_ocr": false, "ocr_lang": "en"}`
- Timeout: 300000 (5 minutes for large PDFs)

**Step 3: Implement polling loop**

After submitting, Docling returns a `task_id`. We poll until complete:

```
Start Docling Conversion → Extract Task ID → [Direct Result?]
                                              ├─ Yes → Use Direct Result
                                              └─ No → Wait 5s → Check Status → [Complete?]
                                                                                ├─ Yes → Get Result
                                                                                └─ No → (loop)
```

Polling endpoint: `GET http://host.docker.internal:5001/v1/status/poll/{task_id}`
Result endpoint: `GET http://host.docker.internal:5001/v1/result/{task_id}`

**Critical:** Document info (document_id, family_id, title) must be passed through the polling loop because n8n Wait nodes lose references to earlier nodes.

**Step 4: Test Docling parsing**

1. Run workflow with test PDF
2. Verify polling completes successfully
3. Check that markdown output preserves tables and headers

**Commit:**
```bash
git add n8n-workflows/document-ingestion.json
git commit -m "feat: add PDF download and Docling async parsing with polling"
```

---

## Task 4: Implement Parent-Child Chunking

**Context:** We split by markdown headers to create semantic chunks. Store parent text for retrieval, embed child chunks for search.

**Step 1: Add Code node for chunking**

Node settings:
- Name: "Chunk Markdown"
- Language: JavaScript
- Code:

```javascript
const markdown = $input.first().json.markdown;
const documentId = $input.first().json.document_id;
const familyId = $input.first().json.family_id;
const title = $input.first().json.title;

// Split by H2 headers (## ) to create parent chunks
const sections = markdown.split(/(?=^## )/gm).filter(s => s.trim());

const chunks = [];
let chunkIndex = 0;

for (const section of sections) {
  const parentText = section.trim();

  // Skip empty sections
  if (parentText.length < 50) continue;

  // Create child chunks (smaller pieces for embedding)
  // Split parent into ~500 char chunks with 100 char overlap
  const words = parentText.split(/\s+/);
  const chunkSize = 100; // words per chunk
  const overlap = 20;    // words overlap

  for (let i = 0; i < words.length; i += (chunkSize - overlap)) {
    const childWords = words.slice(i, i + chunkSize);
    const childText = childWords.join(' ');

    if (childText.length < 50) continue;

    chunks.push({
      chunk_index: chunkIndex++,
      document_id: documentId,
      document_title: title,
      family_id: familyId,
      text: childText,           // Child chunk (for embedding)
      context_text: parentText,  // Parent chunk (for retrieval)
      page_num: 1                // TODO: extract from markdown if available
    });
  }
}

return chunks.map(chunk => ({ json: chunk }));
```

**Step 2: Test chunking**

1. Run workflow with test document
2. Verify output contains multiple chunks
3. Check each chunk has `text`, `context_text`, `family_id`

**Commit:**
```bash
git add n8n-workflows/document-ingestion.json
git commit -m "feat: add parent-child markdown chunking"
```

---

## Task 5: Embed Chunks via Ollama

**Context:** Each chunk needs a vector embedding for semantic search.

**Step 1: Add HTTP Request node for embedding**

Node settings:
- Name: "Embed Chunk"
- Method: POST
- URL: `http://host.docker.internal:11434/api/embeddings`
- Body Content Type: JSON
- JSON Body:
```json
{
  "model": "nomic-embed-text",
  "prompt": "{{ $json.text }}"
}
```

**Step 2: Add Set node to combine chunk with embedding**

Node settings:
- Name: "Prepare Qdrant Payload"
- Assignments:
  - `id` = `{{ parseInt($json.document_id) * 10000 + $json.chunk_index }}` (must be integer)
  - `vector` = `{{ $json.embedding }}`
  - `payload` = object containing all chunk metadata

> **Note:** Qdrant requires point IDs to be integers or UUIDs. String IDs like "27_0" will fail.

**Step 3: Test embedding**

1. Run workflow
2. Verify embedding array has 768 dimensions
3. Check payload structure matches Qdrant schema

**Commit:**
```bash
git add n8n-workflows/document-ingestion.json
git commit -m "feat: add Ollama embedding for chunks"
```

---

## Task 6: Upsert Vectors to Qdrant

**Context:** Store the embedded chunks in Qdrant with family_id for filtering.

**Step 1: Add HTTP Request node for Qdrant upsert**

Node settings:
- Name: "Store in Qdrant"
- Method: PUT
- URL: `http://qdrant:6333/collections/mattervault_documents/points`
- Body Content Type: JSON
- JSON Body:
```json
{
  "points": [
    {
      "id": {{ $json.point_id }},
      "vector": {{ $json.vector }},
      "payload": {
        "family_id": "{{ $json.family_id }}",
        "document_id": "{{ $json.document_id }}",
        "document_title": "{{ $json.document_title }}",
        "text": "{{ $json.text }}",
        "context_text": "{{ $json.context_text }}",
        "chunk_index": {{ $json.chunk_index }},
        "page_num": {{ $json.page_num }}
      }
    }
  ]
}
```

> **Note:** `point_id` must be an integer (e.g., `290001` for doc 29, chunk 1).

**Step 2: Handle batch upserts**

If many chunks, use SplitInBatches node before Qdrant call:
- Batch Size: 100

**Step 3: Add error handling**

Add "Error Trigger" node connected to all HTTP nodes.
Log errors to n8n execution log.

**Step 4: Test full pipeline**

1. Drop fresh PDF in `./intake/morrison/`
2. Wait for workflow to complete
3. Query Qdrant to verify vectors:

```bash
curl -X POST "http://localhost:6333/collections/mattervault_documents/points/scroll" \
  -H "Content-Type: application/json" \
  -d '{"limit": 5, "with_payload": true}'
```

**Step 5: Verify family isolation**

Check that `family_id` matches the subfolder name.

**Commit:**
```bash
git add n8n-workflows/document-ingestion.json
git commit -m "feat: add Qdrant vector storage with family isolation"
```

---

## Task 7: Export and Document Workflow

**Step 1: Export workflow from n8n**

1. Open workflow in n8n
2. Click menu (three dots) → Download
3. Save to `n8n-workflows/document-ingestion.json`

**Step 2: Update CLAUDE.md**

Add to Key Commands section:
```markdown
# Import n8n workflow
# In n8n UI: Import from File → select JSON
```

**Commit:**
```bash
git add n8n-workflows/document-ingestion.json CLAUDE.md
git commit -m "docs: export document ingestion workflow"
```

---

## Verification Milestone

> **Status:** ACHIEVED (2026-01-26)

| Check | Command/Action | Expected | Result |
|-------|----------------|----------|--------|
| Workflow active | n8n UI | Green "Active" toggle | PASS |
| Drop test PDF | `cp test.pdf ./intake/morrison/` | Workflow executes | PASS |
| Paperless has doc | Paperless UI at :8000 | Document visible with "morrison" tag | PASS |
| Qdrant has vectors | `curl localhost:6333/collections/mattervault_documents` | `points_count > 0` | PASS (30 points) |
| Correct family_id | Scroll Qdrant points | `payload.family_id = "morrison"` | PASS |
| Context preserved | Check `context_text` field | Full parent section text | PASS |

**Test Document:** Morrison Family Profile (00_Morrison_Family_Profile.pdf)
**Result:** 30 chunks successfully stored with correct family_id and parent-child structure

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Webhook not firing | Paperless not configured | Configure webhook in Paperless Admin UI |
| Docling timeout | Large PDF | Increase n8n HTTP timeout to 300s |
| Empty embeddings | Ollama not running | `.\scripts\start-native.ps1` |
| Qdrant 400 "not a valid point ID" | String ID used instead of integer | Use `document_id * 10000 + chunk_index` |
| Qdrant 400 wrong dimensions | Wrong embedding model | Verify nomic-embed-text returns 768 dims |
| Missing family_id | No tag on document | Ensure document dropped in family subfolder |
| "Cannot read properties of undefined" | Wait node loses node references | Pass document info through polling loop |
| ECONNREFUSED to Docling | Docling not bound to 0.0.0.0 | Start with `--host 0.0.0.0` |
| Task result not found | Using wrong Docling endpoint | Use `/v1/convert/file/async` with polling |
