# MatterVault

**Private Document Intelligence for Law Firms**

> *"Don't rent a chatbot. Build a facility."*

MatterVault is a self-hosted, air-gapped RAG (Retrieval-Augmented Generation) system designed for legal professionals who cannot—and should not—trust cloud services with confidential client documents.

## Why MatterVault?

| Cloud PDF Chatbots | MatterVault |
|-------------------|-------------|
| Documents sent to third-party servers | **Documents never leave your network** |
| May be used for model training | **Local models, no training** |
| Vendor can access your data | **You own everything** |
| Monthly subscription forever | **One-time hardware investment** |
| Vendor lock-in | **Open-source, portable** |

**The Pitch**: PDF.ai is great for a college student reading a textbook. MatterVault is for a law firm protecting client data.

## Features

- **Magic Folders**: Drop PDFs into `/intake/<family>/` → automatically OCR'd, parsed, and embedded
- **Hybrid Search**: Dense vectors + BM25 sparse search with RRF fusion
- **Multi-Family Isolation**: Query scoped to specific clients/matters
- **Conversation Memory**: Multi-turn chat with persistent history
- **Page-Level Citations**: Click any citation → PDF viewer opens to the exact page
- **7-Year Audit Trail**: Every query logged for compliance
- **Health Dashboard**: Real-time monitoring with email alerts

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Your Premises (Air-Gapped)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   /intake/smith/    ──▶  Paperless-ngx  ──▶  n8n Workflows     │
│   /intake/jones/         (OCR + Storage)     (Orchestration)    │
│                                │                   │            │
│                                ▼                   ▼            │
│                          ┌─────────┐        ┌──────────┐       │
│                          │ Docling │        │  Ollama  │       │
│                          │ (Parse) │        │  (LLM)   │       │
│                          └────┬────┘        └────┬─────┘       │
│                               │                  │              │
│                               └────────┬─────────┘              │
│                                        ▼                        │
│                                   ┌─────────┐                   │
│                                   │ Qdrant  │                   │
│                                   │(Vectors)│                   │
│                                   └────┬────┘                   │
│                                        │                        │
│                                        ▼                        │
│                              ┌──────────────────┐               │
│                              │    Chat-UI       │               │
│                              │  (Attorneys)     │               │
│                              └──────────────────┘               │
│                                                                 │
│   NO DATA LEAVES THIS BOX                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- 32GB+ RAM recommended
- NVIDIA GPU (optional, for faster inference)
- Windows/Mac/Linux host for Ollama and Docling

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-org/mattervault.git
cd mattervault

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings

# 3. Start native services (Windows PowerShell)
.\scripts\start-native.ps1

# 4. Start Docker services
docker compose up -d

# 5. Initialize the system
./scripts/init-mattervault.sh

# 6. Create intake folders for your clients
mkdir -p ./intake/smith ./intake/jones
```

### First Use

1. **Login to Paperless** at http://localhost:8000 (create admin user on first run)
2. **Drop a PDF** into `/intake/smith/`
3. **Open Chat-UI** at http://localhost:3007
4. **Login** with your Paperless credentials
5. **Select "smith"** from the family dropdown
6. **Ask a question** about your document

## Services

| Service | URL | Purpose |
|---------|-----|---------|
| Chat-UI | http://localhost:3007 | Attorney interface |
| Health Dashboard | http://localhost:3006 | System monitoring |
| Paperless-ngx | http://localhost:8000 | Document vault |
| n8n | http://localhost:5678 | Workflow editor |
| Qdrant | http://localhost:6333/dashboard | Vector database |

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — Technical architecture and developer guide
- **[PRODUCT_VISION.md](./PRODUCT_VISION.md)** — Product philosophy and roadmap
- **[docs/NEXT_STEPS.md](./docs/NEXT_STEPS.md)** — Implementation backlog

## Security

- **Air-Gapped**: No external API calls. Ollama and Docling run locally.
- **No Training**: Your documents never improve anyone else's models.
- **Audit Trail**: Every query logged with 7-year retention.
- **Encryption**: SSL in transit, configurable encryption at rest.

## Testing

```bash
# Full E2E test suite
docker exec mattertest /e2e/test.sh all

# Quick smoke test
docker exec mattertest /e2e/test.sh test

# Health check
./scripts/health-check.sh
```

## License

[MIT License](./LICENSE) — Use it, modify it, own it.

## Contributing

MatterVault is built for law firms, by people who understand that client confidentiality isn't negotiable. Contributions welcome.

---

**Own your intelligence. Own your infrastructure. Own your future.**
