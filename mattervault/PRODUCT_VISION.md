# MatterVault Product Vision

> **"Don't rent a chatbot. Build a facility."**

## The Problem

Law firms handle the most sensitive information in existence: client communications, litigation strategy, financial records, estate plans, and privileged documents. Yet the market offers them two bad choices:

1. **Cloud PDF chatbots** (PDF.ai, ChatPDF, etc.) — Your confidential client documents flow through third-party servers, are processed by OpenAI/Anthropic/Google APIs, and may be retained for model training. One data breach or subpoena, and your privilege is gone.

2. **Enterprise legal AI** (Harvey, CoCounsel) — Six-figure annual contracts, vendor lock-in, and your knowledge base lives on someone else's infrastructure.

Neither option respects the fundamental truth of legal practice: **client data must never leave your control.**

## The MatterVault Difference

MatterVault is not a chatbot. It is a **Private Intelligence Facility** — a self-hosted, air-gapped document intelligence system that runs entirely on your premises.

### Core Principles

| Principle | What It Means |
|-----------|---------------|
| **Air-Gapped** | No data ever leaves your network. No API calls to OpenAI, Anthropic, or Google. Every computation happens on hardware you own. |
| **Ownership** | You own the embeddings, the vector database, the LLM weights, and the audit logs. No vendor can revoke access or change terms. |
| **Transparency** | Open-source components (Paperless-ngx, n8n, Qdrant, Ollama). No black boxes. Full audit trail of every query. |
| **Compliance-Ready** | 7-year audit retention, chain-of-custody logging, role-based access. Built for legal professional responsibility requirements. |

### The Competitive Reality

| Capability | PDF.ai / ChatPDF | Enterprise Legal AI | **MatterVault** |
|------------|------------------|---------------------|-----------------|
| Data leaves premises | Yes (cloud processing) | Yes (vendor servers) | **Never** |
| Model training on your docs | Possible | Varies by contract | **Impossible** |
| Vendor can access data | Yes | Yes | **No vendor** |
| Subpoena-resistant | No | No | **Your control** |
| Cost model | Per-user subscription | Enterprise contract | **One-time hardware** |
| Cancellation impact | Lose access | Lose access | **You keep everything** |

## The Killer Pitch

> *"PDF.ai is great for a college student reading a textbook. MatterVault is for a law firm protecting client data. We don't rent you a chatbot; we build you a private intelligence facility that you own, on your premises, that no opposing counsel or tech company can ever access."*

## Target Users

### Primary: Small-to-Midsize Law Firms (5-50 attorneys)

- Estate planning, trust administration, family law
- Handle sensitive financial and personal information
- Cannot afford enterprise legal AI, but need more than consumer tools
- Often have existing document management pain (paper files, disorganized drives)

### Secondary: Legal Departments in Regulated Industries

- Healthcare, financial services, government contractors
- Strict data residency and compliance requirements
- Need document intelligence without cloud exposure

## Product Philosophy

### 1. Invisible Infrastructure

Paralegals should drop files into a folder and forget about it. Attorneys should ask questions and get answers. The complexity of embeddings, vector search, and LLMs should be invisible.

### 2. Trust Through Transparency

Every answer includes citations. Every citation links to the source page. Every query is logged with full audit trail. The system earns trust by showing its work.

### 3. Legal-Grade Reliability

Silence is better than hallucination. When the system doesn't know, it says so. When OCR is uncertain, it flags it. The system is a tool for verification, not a replacement for judgment.

### 4. Operational Simplicity

One `docker compose up` to start. Health dashboard to monitor. E2E tests to verify. No Kubernetes, no microservices sprawl, no DevOps team required.

## Feature Roadmap

### Current Capabilities (v1.0)

- **Magic Folders**: Drop PDFs into `/intake/<family>/` → auto-tagged, OCR'd, embedded
- **Hybrid Search**: Dense vectors + BM25 sparse vectors with RRF fusion
- **Multi-Family Isolation**: Query scoped to specific client/matter via payload filtering
- **Conversation Memory**: Multi-turn chat with persistent history
- **Page-Level Citations**: Click citation → PDF viewer opens to exact page
- **Audit Logging**: 7-year retention with export API
- **Health Dashboard**: Real-time monitoring with alerting

### Near-Term Roadmap

| Feature | Description | Status |
|---------|-------------|--------|
| **Ingestion Status Tags** | Paralegals see `processing` → `ai_ready` → `error` tags in Paperless | Planned |
| **Large PDF Handling** | Pre-split PDFs >25 pages before Docling processing | Planned |
| **Prompt Library** | Dropdown of "Quick Actions" for standardized queries (e.g., "Summarize Key Terms," "Find Risk Clauses," "Draft Statutory Summary") | Planned |
| **Metadata Filtering** | Filter search by date range, document type, correspondent | Planned |

### Future Vision

| Feature | Description |
|---------|-------------|
| **Visual Intelligence** | Llama 3.2 Vision integration to analyze charts, graphs, and tables detected by Docling — converting visual data to searchable text |
| **Cross-Family Analysis** | Query across multiple families with appropriate access controls (e.g., "Find all trusts with this provision") |
| **Citation Export** | Format citations for court filings (Bluebook, local rules) |
| **Saved Query Templates** | Firm-wide library of reusable queries for common tasks |
| **Per-Family Access Control** | Restrict users to specific families based on role/permissions |

## Security Model

### Data Protection

- **At Rest**: Documents stored in Paperless-ngx with configurable encryption
- **In Transit**: All internal communication over Docker network (no external exposure)
- **Processing**: Ollama runs locally — embeddings and LLM inference never leave the machine
- **No Training**: Local models are static — your documents never improve anyone else's AI

### Audit & Compliance

- Every query logged with: user, timestamp, question, answer, documents cited
- Audit logs partitioned by month, archived after 7 years
- Export API for compliance review or e-discovery response
- Full n8n execution history for debugging

### Access Control

- Authentication via Paperless-ngx credentials (single source of truth)
- JWT tokens with Redis session management
- Role sync for admin capabilities
- Family selection is per-conversation (open access model for trusted teams)

## Success Metrics

### For the Firm

- **Time saved**: Hours per week not spent manually searching documents
- **Confidence**: Attorneys trust answers because they can verify citations
- **Compliance**: Clean audit trail for any professional responsibility inquiry

### For the System

- **Uptime**: Health dashboard shows 99%+ availability
- **Accuracy**: Hallucination rate near zero (measured by adversarial testing)
- **Coverage**: All ingested documents searchable within 15 minutes of drop

## The Bottom Line

MatterVault exists because law firms deserve document intelligence without surveillance capitalism. Your clients trust you with their secrets. You should be able to trust your tools with the same.

**Own your intelligence. Own your infrastructure. Own your future.**

---

*MatterVault is open-source software. No vendor. No subscription. No compromise.*
