Here is a curated **Future Roadmap** tailored specifically for the Mattervault architecture.

I have broken these down by **"Why you’d want it"** and **"How to do it correctly"** (keeping your GPU acceleration and air-gap intact).

You can save this as `FUTURE_ROADMAP.md`.

---

# Mattervault Future Roadmap

## Phase 1: Enhanced Intelligence (Models & Prompts)

### 1. Legal-Specific LLMs (The "Saul Goodman" Upgrade)

* **Goal:** Replace general-purpose models (Llama 3) with models fine-tuned on case law and statutes.
* **Candidates:** `SaulLM-7B`, `Law-BERT` (if updated), or `Harvey` equivalents.
* **Implementation Strategy:**
* **❌ N8N HuggingFace Node:** Do **not** use this for heavy models. It runs inside the Docker container on CPU. It will be agonizingly slow and kill your performance.
* **✅ Custom Ollama Model:** Download the GGUF version of the legal model from HuggingFace. Create a `Modelfile` in Ollama.
* *Command:* `ollama create mattervault-legal -f ./Modelfile`
* *Benefit:* Keeps full Native GPU/Metal acceleration on the host.



### 2. Statutory Prompt Library (System Prompt Engineering)

> **Validated by external market signal:** The Shapiro "Claude-Native Law Firm" analysis confirms that system-prompt-as-competitive-advantage is a real differentiator. Well-crafted system prompts for legal tasks are the highest-ROI improvement available — zero infrastructure cost, immediate quality improvement.

* **Goal:** Switch the AI's "brain" based on the task (e.g., "Drafting" vs. "Interpretation").
* **The Nuance:** "Statutory language" requires strict adherence to text, whereas "Client Summaries" require plain English.
* **Implementation:**
* Create a "Router" in n8n.
* **Prompt A (Strict):** *"You are a Statutory Interpreter. Adhere strictly to the definitions in the provided text. Do not infer intent."*
* **Prompt B (Client):** *"You are an Estate Planner. Explain these clauses in simple, comforting terms for a layperson."*



---

## Phase 2: Security & Governance

### 3. Named Entity Recognition (NER) & Redaction

> **⚠️ HIGH PRIORITY** — Implement immediately after core pipeline is production-ready.
> SSNs and financial account numbers are compliance nightmares if accidentally exposed.

* **Goal:** Automatically identify and "blur" sensitive data (SSNs, Bank Account #s).
* **Use Case:** Critical if you ever need to **export** a document to a 3rd party or opposing counsel, but keeping the original un-redacted for internal search.
* **Implementation:**
* Use a lightweight, local NER model (like `GLiNER` or `Spacy`) running in a Python script via n8n **Code Node**.
* *Workflow:* PDF Ingest -> Text Extracted -> NER Scan -> **Create "Public" Version** (Redacted) + **Keep "Private" Version** (Original).
* *Note:* Do not redact the version stored in Qdrant, or you won't be able to search for the SSN when you actually need it.



### 4. Advanced RBAC (Role-Based Access Control)

* **Goal:** Prevent the "Intern" from seeing the "VIP Client" folders, or strictly separate "Family Law" from "Estate Planning" departments.
* **Current Limit:** The n8n Chat UI is "all or nothing" or relies on simple Basic Auth.
* **Implementation:**
* **The Frontend Layer:** Deploy a dedicated UI tool like **Open WebUI** or **Streamlit** that connects to your n8n API.
* These tools handle user login (admin vs. user).
* **Logic:**
* User `Paralegal_Jane` logs in.
* UI passes variable `user_role="staff"` to n8n.
* n8n enforces Qdrant Filter: `filter: { must_not: [ { key: "sensitivity", match: { value: "partner_only" } } ] }`.





---

## Phase 3: Data Integrity (The "Milvus" List)

### 5. Preventing Embedding Drift

* **The Problem:** If you switch from `nomic-embed-text-v1` to `v1.5`, the mathematical numbers change. Your old vectors become garbage and won't match new searches.
* **Implementation (Versioning):**
* **Tagging:** When ingesting in n8n, add a metadata field: `model_version: "nomic-v1.5"`.
* **The Safety Check:** In your search workflow, check the active model version. If it differs from the document's version, trigger a "Re-Index" alert.
* **The Fix:** A "Midnight Maintenance" workflow in n8n that wipes Qdrant and re-processes documents from Paperless using the new model.



### 6. Audit Logging (Chain of Custody)

* **Goal:** Know exactly *who* asked *what* and *which* document was retrieved. Essential for liability.
* **Implementation:**
* **Postgres Logging:** Add a step in n8n after every chat response.
* *Log:* Timestamp, User, Query, **List of Cited Document IDs**, and AI Response.
* *Value:* If a client sues saying "You told me the trust said X," you can pull the logs and prove the AI cited the document correctly (or incorrectly) at that time.



---

### Summary of Priorities

1. **Now:** Focus on **Statutory Prompts / Prompt Engineering** (Highest ROI — zero cost, immediate quality gains, validated by Shapiro analysis).
2. **Soon:** **NER/Redaction** (High priority once core pipeline is stable — compliance risk).
3. **Later:** **Legal-Specific Models** (Wait for the open-source legal models to mature and support larger context windows).

> **Note:** Audit Logging (item 2 in original roadmap) is now complete — implemented with 7-year retention, partitioned tables, and JSONL export.