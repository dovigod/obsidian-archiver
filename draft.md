AI Knowledge Hub — Initial Architecture Spec
Goal

Build a personal knowledge hub that continuously collects interactions from multiple AI agents and converts them into reusable structured knowledge.

Sources:

ChatGPT
Claude
Claude Code
Gemini
future local agents

Primary storage:

Obsidian vault as canonical human-readable knowledge base
Core Principles
1. Raw conversations are not knowledge

Raw logs must be preserved, but they are not the final product.

The system must transform conversations into:

decisions
reusable concepts
debugging patterns
architecture notes
implementation references
2. Markdown is the source of truth

Avoid vendor lock-in.

Everything important must exist as:

markdown
yaml metadata
local filesystem
3. Separate layers

Never mix raw conversations and distilled knowledge.

Directory Structure
vault/

  raw/
    conversations/
      2026/
        05/

  knowledge/
    backend/
    distributed-systems/
    databases/
    blockchain/
    infrastructure/

  decisions/

  debugging/

  patterns/

  projects/
    tada-wallet/
    attestation-service/

  indexes/
Canonical Conversation Schema

Every captured conversation must follow the same structure.

Example:

---
id: convo-uuid

source: claude-code
model: claude-sonnet

created_at: 2026-05-02T14:22:00Z

project:
  - tada-wallet

topics:
  - redis
  - replica-lag
  - database-consistency

conversation_type:
  - debugging

tags:
  - backend
  - production-issue

git:
  repo: tada-wallet
  branch: fix/point-status

---

# User

Why is PointRequest stuck in SENT state?

# Assistant

Replica lag may cause stale reads...
Capture Layer
Stage 1 Priority
Claude Code

Capture:

prompt
response
cwd
git branch
modified files
timestamp

Reason:

Claude Code interactions contain high-value engineering reasoning.

Stage 2

API-based agents:

OpenAI API
Gemini API
Stage 3

Browser capture:

ChatGPT web
Claude web

Possible implementation:

browser extension
DOM observer
export listener
MCP Memory Server

Purpose:

Provide a unified memory interface across agents.

Initial Tools
archive_conversation

Stores normalized conversation.

Input:

{
  "source": "claude-code",
  "messages": [],
  "metadata": {}
}
search_memory

Search previous conversations and knowledge notes.

save_decision

Store architecture or engineering decisions.

get_related_knowledge

Retrieve related notes from Obsidian vault.

Processing Pipeline
Step 1 — Raw Archive
conversation
    ↓
normalize
    ↓
markdown export
    ↓
raw/conversations/
Step 2 — Classification

Automatically extract:

topics
technologies
debugging categories
architecture themes
Step 3 — Distillation

Transform conversations into atomic knowledge notes.

Example transformation:

conversation
    ↓
extract concepts
    ↓
generate reusable note
Atomic Note Rules

Each note should contain exactly one concept.

Good:

Replica Lag Failure Pattern

Bad:

Conversation with Claude on April 5
Decision Log Format

Example:

# Why PointRequest reads moved to Primary DB

## Problem

Replica lag caused stale reads.

## Decision

Critical status reads moved to primary DB.

## Tradeoff

Higher load on primary database.

## Related Concepts

- eventual consistency
- replica lag
Knowledge Extraction Categories

The system should automatically detect:

debugging patterns
architectural decisions
operational lessons
reusable code snippets
infrastructure failures
anti-patterns
Retrieval Layer
Phase 1
full text search
Phase 2
embeddings
semantic retrieval
Phase 3
graph relationships
context-aware recall
Long-Term Vision
AI interactions
    ↓
structured memory
    ↓
personal knowledge graph
    ↓
future AI-assisted reasoning

Goal:

Build accumulated engineering intelligence rather than storing disposable conversations.

Recommended Tech Stack
Role	Recommendation
MCP server	TypeScript
metadata storage	SQLite
vector search	sqlite-vec
archive format	Markdown
knowledge base	Obsidian
sync	Git
Immediate Next Actions
1. Create Obsidian vault structure
2. Define final metadata schema
3. Implement Claude Code capture
4. Build minimal MCP server

Required tools:

archive_conversation
search_memory
5. Automate raw markdown export
6. Implement classification pipeline
7. Implement knowledge distillation pipeline