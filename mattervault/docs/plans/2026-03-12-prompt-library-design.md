# Prompt Library (Quick Actions) — Design

*2026-03-12*

## Problem

Junior associates ask inconsistent questions, get inconsistent results. Experienced attorneys have standard queries they repeat manually. No way to standardize or share effective prompts across the firm.

## Solution

Pre-built "Quick Actions" that send standardized prompts with one click. Ships with 5 defaults; admins can add, edit, reorder, and disable actions for their firm.

## UI

### Welcome Screen Cards

Below the "Welcome to Mattervault" text, a grid of action cards appears. Each card shows an icon, title, and one-line description. Cards are disabled (dimmed) until a family is selected. Clicking a card sends the prompt immediately.

### Input Area Menu

A lightning-bolt icon button to the left of the text input. Clicking opens a popup menu above the input listing all actions vertically. Same disabled-until-family-selected behavior. Menu closes after selection or click-outside. Available at any point in a conversation.

### Visual Style

- Welcome cards: `--bg-surface` with `--border-subtle`, teal accent on hover
- Input menu: matches existing export dropdown pattern
- Mobile: welcome cards stack single-column; input menu works the same

### Behavior

- Family must be selected before any action can fire
- Actions send immediately on click (no paste-to-edit)
- Actions are available both on welcome screen and mid-conversation via input menu

## Data Model

### Table: `prompt_templates`

| Column | Type | Purpose |
|--------|------|---------|
| `id` | UUID (PK) | Unique identifier |
| `title` | VARCHAR(100) | Display name |
| `description` | VARCHAR(255) | One-liner shown on card |
| `icon` | VARCHAR(50) | Preset icon identifier |
| `prompt_text` | TEXT | Prompt sent to chat workflow |
| `sort_order` | INTEGER | Display ordering |
| `is_default` | BOOLEAN | Ships with system (non-deletable) |
| `enabled` | BOOLEAN | Toggle visibility |
| `created_by` | UUID (FK → users) | Creator |
| `created_at` | TIMESTAMP | Created |
| `updated_at` | TIMESTAMP | Last edit |

Seeded via migration with 5 defaults (`is_default = true`). Admins can disable defaults but not delete them.

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/prompts` | Any user | List enabled templates (sorted) |
| `POST` | `/api/prompts` | Admin | Create template |
| `PUT` | `/api/prompts/:id` | Admin | Update template |
| `DELETE` | `/api/prompts/:id` | Admin | Delete (rejects `is_default`) |
| `PATCH` | `/api/prompts/reorder` | Admin | Bulk update sort_order |

## Default Prompts

1. **Summarize Key Terms** — "Provide a structured summary of the key terms across all documents, including parties, dates, obligations, and notable provisions."

2. **Flag Issues & Concerns** — "Review all documents and identify potential issues, risks, or concerns such as ambiguous language, missing contingencies, conflicting terms, or gaps that may need attorney review."

3. **List All Documents** — "List every document in this family's vault with its type, date, and a brief description of its purpose."

4. **Timeline of Events** — "Extract a chronological timeline of all significant events, dates, and milestones from the documents, citing the source document for each entry."

5. **Identify Parties & Roles** — "Identify every person and entity mentioned across all documents, their roles, which documents they appear in, and relationships between them."

Prompts are concise and model-agnostic — designed to work well with any model from 8B to 70B+.

## Admin Management Page

New `prompts.html` — admin-only, same pattern as `audit.html`.

### Features

- List of all templates with icon, title, description, enabled toggle, edit/delete buttons
- Drag-to-reorder (updates `sort_order` via PATCH endpoint on drop)
- Icon picker from preset SVG icon list (no upload)
- Create/edit via inline modal (title, description, icon, prompt text)
- Delete blocked for `is_default = true` templates
- Linked from user menu dropdown

## Implementation Scope

1. Database migration (new table + seed defaults)
2. API routes (`/api/prompts` CRUD + reorder)
3. Chat UI: welcome screen cards + input area menu
4. Admin page: `prompts.html` with drag-reorder and icon picker
