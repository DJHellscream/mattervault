# Phase 3: Family Selector UI

> **Status:** COMPLETE (2026-01-27)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add family selection at the start of each chat session so queries are automatically filtered to the correct tenant's documents.

**Architecture:** On session start, prompt user to select family → store selection in session memory → all subsequent queries in that session use the stored family_id filter.

**Tech Stack:** n8n Chat Trigger, n8n Memory nodes, Qdrant filter

---

## Prerequisites

- Phase 2 complete (chat working with hardcoded family)
- Multiple families with indexed documents for testing

Verify multiple families exist:
```bash
curl -X POST "http://localhost:6333/collections/mattervault_documents/points/scroll" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "with_payload": ["family_id"]}'
```

---

## Task 1: Add Session Memory

**Context:** n8n Chat Trigger creates sessions, but we need to store the family selection.

**Step 1: Add Memory node to workflow**

1. Open "Mattervault Chat" workflow
2. Add node: "Window Buffer Memory" (or "Simple Memory")
3. Configure:
   - Session ID: `{{ $json.sessionId }}`
   - Context Window Length: 10

**Step 2: Position memory node**

Connect Chat Trigger → Memory → rest of workflow.

Memory node will provide conversation history context.

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add session memory to chat workflow"
```

---

## Task 2: Detect New Session and Prompt for Family

**Context:** When a new session starts, ask user to select their family before answering questions.

**Step 1: Add Code node to check session state**

Node settings:
- Name: "Check Session State"
- Language: JavaScript
- Code:

```javascript
const chatInput = $input.first().json.chatInput;
const sessionId = $input.first().json.sessionId;

// Check if this is a family selection response
const familyMatch = chatInput.toLowerCase().match(/^(morrison|johnson|smith)$/);

if (familyMatch) {
  return [{
    json: {
      action: 'set_family',
      family_id: familyMatch[1],
      session_id: sessionId
    }
  }];
}

// Check memory for existing family selection
// (In production, query a session store)
// For MVP, we use a simple keyword detection

// If input starts with "family:", extract it
const familyPrefix = chatInput.match(/^family:\s*(\w+)/i);
if (familyPrefix) {
  return [{
    json: {
      action: 'set_family',
      family_id: familyPrefix[1].toLowerCase(),
      session_id: sessionId,
      follow_up: chatInput.replace(/^family:\s*\w+\s*/i, '').trim()
    }
  }];
}

// Default: assume family is already set or needs prompting
return [{
  json: {
    action: 'query',
    question: chatInput,
    session_id: sessionId,
    family_id: null  // Will be filled from session or prompt
  }
}];
```

**Step 2: Add Switch node for routing**

Node settings:
- Name: "Route by Action"
- Rules:
  - `set_family`: action equals "set_family"
  - `query`: action equals "query"

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add session state detection and routing"
```

---

## Task 3: Handle Family Selection

**Context:** When user selects a family, confirm and store it.

**Step 1: Add Set node for family confirmation**

Node settings:
- Name: "Confirm Family Selection"
- Assignments:
  - `response` = `Selected family: {{ $json.family_id }}. You can now ask questions about {{ $json.family_id }} documents. What would you like to know?`
  - `family_id` = `{{ $json.family_id }}`

**Step 2: Store in session (MVP approach)**

For MVP, we'll use n8n's built-in workflow static data:

Add Code node:
- Name: "Store Family in Session"
- Code:

```javascript
const staticData = $getWorkflowStaticData('global');
const sessionId = $input.first().json.session_id;
const familyId = $input.first().json.family_id;

// Store family for this session
if (!staticData.sessions) {
  staticData.sessions = {};
}
staticData.sessions[sessionId] = {
  family_id: familyId,
  created_at: new Date().toISOString()
};

return [{
  json: {
    response: `Now viewing documents for the ${familyId.charAt(0).toUpperCase() + familyId.slice(1)} family. What would you like to know?`,
    family_id: familyId
  }
}];
```

**Step 3: Connect to Chat Trigger response**

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add family selection storage"
```

---

## Task 4: Retrieve Family from Session for Queries

**Context:** When processing a query, look up the stored family_id.

**Step 1: Modify query path to check session**

Add Code node at start of query path:
- Name: "Get Family from Session"
- Code:

```javascript
const staticData = $getWorkflowStaticData('global');
const sessionId = $input.first().json.session_id;
const question = $input.first().json.question;

// Check if family is set for this session
const session = staticData.sessions?.[sessionId];

if (!session?.family_id) {
  // No family selected yet - prompt user
  return [{
    json: {
      action: 'prompt_family',
      message: 'Please select a family first. Type one of: Morrison, Johnson, Smith'
    }
  }];
}

return [{
  json: {
    action: 'continue',
    question: question,
    family_id: session.family_id,
    session_id: sessionId
  }
}];
```

**Step 2: Add Switch node after session check**

- `prompt_family`: Return the prompt message
- `continue`: Proceed to embedding and search

**Step 3: Connect prompt path to Chat response**

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add family retrieval from session"
```

---

## Task 5: Add Welcome Message

**Context:** When chat first opens, greet user and prompt for family selection.

**Step 1: Modify Chat Trigger settings**

In Chat Trigger node:
- Initial Message: `Welcome to Mattervault. Please select a family to begin: Morrison, Johnson, or Smith`

**Step 2: Test welcome flow**

1. Open new chat session
2. See welcome message with family options
3. Type "Morrison"
4. See confirmation message
5. Ask a question
6. Get response filtered to Morrison documents

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add welcome message with family prompt"
```

---

## Task 6: Add Family List from Qdrant (Dynamic)

**Context:** Instead of hardcoding families, fetch available families from Qdrant.

**Step 1: Add HTTP Request to get unique families**

Node settings:
- Name: "Get Available Families"
- Method: POST
- URL: `http://qdrant:6333/collections/mattervault_documents/points/scroll`
- Body:
```json
{
  "limit": 1000,
  "with_payload": ["family_id"]
}
```

**Step 2: Add Code node to extract unique families**

```javascript
const points = $input.first().json.result.points;
const families = [...new Set(points.map(p => p.payload.family_id))];

return [{
  json: {
    families: families,
    family_list: families.join(', ')
  }
}];
```

**Step 3: Update welcome message**

Use dynamic family list:
`Welcome to Mattervault. Available families: {{ $json.family_list }}. Type a family name to begin.`

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add dynamic family list from Qdrant"
```

---

## Task 7: Session Cleanup (Optional)

**Context:** Clean up old sessions to prevent memory bloat.

**Step 1: Add cleanup logic to session storage**

In "Store Family in Session" Code node, add:

```javascript
// Clean up sessions older than 24 hours
const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
for (const [sid, data] of Object.entries(staticData.sessions || {})) {
  if (new Date(data.created_at) < oneDayAgo) {
    delete staticData.sessions[sid];
  }
}
```

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json
git commit -m "feat: add session cleanup for old entries"
```

---

## Task 8: Export and Document

**Step 1: Export final workflow**

Save to `n8n-workflows/mattervault-chat.json`

**Step 2: Update CLAUDE.md**

Add section on family selection flow.

**Commit:**
```bash
git add n8n-workflows/mattervault-chat.json CLAUDE.md
git commit -m "docs: document family selector workflow"
```

---

## Verification Milestone

| Check | Action | Expected |
|-------|--------|----------|
| Welcome shows | Open new chat | "Welcome... Available families: ..." |
| Family list dynamic | Add new family docs | New family appears in list |
| Selection works | Type "Morrison" | "Now viewing Morrison documents" |
| Queries filtered | Ask question | Only Morrison results |
| Session persists | Ask follow-up | Still uses Morrison (no re-prompt) |
| New session resets | Open new chat tab | Prompted for family again |
| Invalid family | Type "InvalidName" | Error message, re-prompt |

---

## Integration Test: Cross-Family Isolation

**Critical security test:**

1. Index documents for both Morrison and Johnson families
2. Start session, select "Morrison"
3. Ask: "What is in the Johnson trust?"
4. **Expected:** "I don't have information about that" (NOT Johnson data)
5. Start new session, select "Johnson"
6. Ask same question
7. **Expected:** Returns Johnson trust information

If step 4 returns Johnson data, there's a critical bug in family filtering.

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Family not persisting | Static data not saving | Check n8n workflow settings |
| Wrong family returned | Session ID mismatch | Log session IDs, verify uniqueness |
| All families shown | Filter not applied | Check Qdrant query has filter |
| Session lost on restart | n8n restarted | Expected; sessions are in-memory |
