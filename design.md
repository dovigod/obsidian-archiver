# AI Knowledge Hub — Implementation Design

Companion to `draft.md`. The spec describes the *what*; this document describes the *how*.

## Tech stack

- **Language**: TypeScript (plain TS, no framework — NestJS rejected as overkill for stdio MCP)
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Validation**: zod
- **Frontmatter**: gray-matter
- **IDs**: uuid v7 (time-ordered)
- **LLM**: pluggable provider; Claude API as initial impl
- **Storage**: filesystem (markdown + JSON canvas + Obsidian Bases) + git auto-commit
- **Output format**: Obsidian Flavored Markdown (spec lifted from `kepano/obsidian-skills`)

## Architecture

Core library + thin adapters. Three entrypoints share one core:

```
                  ┌──────────────────┐
                  │  core (lib)      │
                  └────────┬─────────┘
        ┌─────────────────┼─────────────────┐
   bin/mcp-server     bin/cli         bin/worker
   (live capture)     (hooks/backfill) (async classification)
```

## Config-first principle

Every behavior discussed is configurable. Layered config:

1. `~/.knowledge-hub/config.json` — global defaults
2. `<project>/.knowledge-hub/config.json` — per-project overrides (deep-merged)

Schema (validated by zod, defaults in code):

```jsonc
{
  "vault": { "path": "/abs/path/to/vault" },

  "capture": {
    "mode": "auto",                  // "auto" | "manual"
    "sources": { "claude_code": true }
  },

  "classification": {
    "enabled": true,
    "execution": "async",            // "async" | "sync"
    "llm": {
      "provider": "claude",          // pluggable: "claude" | "openai" | "local"
      "model": "claude-opus-4-7",
      "api_key_env": "ANTHROPIC_API_KEY"
    }
  },

  "page_update_strategy": "llm_rewrite",  // "append" | "llm_rewrite" | "hybrid"

  "autonomy": {
    "mode": "hybrid",                // "auto" | "proposal" | "hybrid"
    "auto_actions": ["create_entity", "update_entity", "add_to_index"],
    "proposal_actions": ["split_category", "merge_entities", "rename_entity", "delete_page"]
  },

  "entity_resolution": {
    "method": "llm",                 // "fuzzy" | "llm" | "hybrid"
    "graph_max_entities": 500
  },

  "views": {
    "canvases": {
      "per_category": true,
      "per_entity":   true,
      "global_graph": true
    },
    "bases": { "entity_catalog": true }
  },

  "git": { "auto_commit": true },

  "ids": { "strategy": "uuid_v7" }
}
```

## Knowledge model

**One canonical page per entity.** `Redis.md` exists once, linked from multiple category index pages (`Database.md`, `Caching.md`). No aspect-specific duplicates — multi-categorization is N indexes pointing to one entity page.

**Vault layout:**

```
vault/
  raw/
    conversations/YYYY/MM/{uuid7}.md      # append-only source of truth
  knowledge/
    {Entity}.md                           # canonical entity pages, LLM-rewritten
    indexes/{Category}.md                 # derived index pages
    canvases/
      {Category}.canvas                   # per-category visual graph
      {Entity}.canvas                     # per-entity neighborhood graph
      _global.canvas                      # whole-graph view
    EntityCatalog.base                    # Obsidian Bases database view
  _proposals/                             # pending taxonomy changes
  _queue/                                 # filesystem job queue
```

## Page-update strategy: LLM-rewrite

When new content arrives for an existing entity, the system passes existing page + new conversation to the LLM and writes back an integrated rewrite. Implications baked into design:

- Mandatory git auto-commit per page write (recovery via `git revert`)
- "Preserve existing facts unless contradicted" framing in synthesis prompt
- Token-budget cap with summarize-older-sections fallback as pages grow

## Capture modes

- **Auto** — Claude Code Stop hook invokes `cli.ts archive-transcript`. Hook never blocks Claude (exits 0 on archive failure). Async classification job enqueued to `_queue/`.
- **Manual** — user calls `archive_conversation` MCP tool from within a Claude Code session.

Configurable per-project and globally.

## Staged build

| Stage | Output | Exit criterion |
|---|---|---|
| 1 | Raw archive | Claude Code session produces `vault/raw/conversations/.../*.md`, frontmatter parses in Obsidian |
| 2 | Entity pages via LLM classification + synthesis | Two Redis conversations produce one `knowledge/Redis.md` integrating both, with backlinks |
| 3 | Derived views — markdown indexes, JSON canvases, Obsidian Bases catalog | `Database.md`, `Database.canvas`, `EntityCatalog.base` all reference `Redis.md` |
| 4 | Taxonomy rebalancing — split / merge / rename with link rewrite | Triggered split of an oversized category preserves all wikilinks |
| 5 | Backfill scraper, additional capture sources, semantic retrieval | Out of scope until 1–4 stable |

## Target repo layout

```
src/
  core/
    config.ts          # zod-validated global+project config loader
    schema.ts          # Conversation, Entity, Category schemas
    ids.ts             # uuid v7
    normalize.ts
    transcript.ts      # Claude Code JSONL → Conversation
    repository/
      raw.ts           # MarkdownVaultRepository (Stage 1)
      knowledge.ts     # entity/index page repo (Stage 2-3)
      canvas.ts        # JSON Canvas generator (Stage 3)
      bases.ts         # Obsidian Bases generator (Stage 3)
    llm/
      provider.ts      # interface
      claude.ts
      prompts/
        obsidian-markdown.md   # OFM spec (kepano/obsidian-skills, MIT, attribution preserved)
        synthesize.md
        classify.md
        resolve.md
    pipeline/
      classify.ts
      resolve.ts       # entity resolution via graph passed to LLM
      synthesize.ts
      reindex.ts
      rebalance.ts
    queue/
      fs-queue.ts
    git.ts
  bin/
    mcp-server.ts      # stdio MCP — exposes archive_conversation
    cli.ts             # subcommands: archive-transcript, worker, rebalance, apply-proposal
    worker.ts          # async classification consumer
test/
package.json
tsconfig.json
```

## External references

- Spec source: `draft.md`
- `kepano/obsidian-skills` (MIT) — https://github.com/kepano/obsidian-skills
  - `obsidian-markdown` → inlined into synthesis prompts (with license header)
  - `json-canvas` → informs canvas generator
  - `obsidian-bases` → informs Bases catalog generator
- MCP SDK — https://github.com/modelcontextprotocol/typescript-sdk
- JSON Canvas spec — https://jsoncanvas.org/

## Deferred risks (not blockers)

1. Claude Code Stop hook contract may vary between versions — confirm at Stage 1 wiring time.
2. Entity-graph prompt size — pre-filter via keyword retrieval once graph exceeds ~500 entities; later add sqlite-vec.
3. Page identity stability — entity-name filenames are MVP; restructuring carries link-rewrite step. Switch to uuid-based filenames if rename churn becomes a problem.
4. LLM-rewrite quality — heavy reliance on prompt engineering; mitigated by mandatory git auto-commit.
