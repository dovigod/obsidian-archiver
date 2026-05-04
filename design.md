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

## Concurrency: single sequential queue

Multiple capture requests can arrive concurrently — two MCP tool calls in flight, a Stop hook firing while a manual archive is running, two parallel Claude Code sessions ending at once. Concurrent processing races on three shared resources: the git index (`.git/index.lock`), and at Stage 2+ the same entity page (`knowledge/Redis.md`) and the same index file. Rather than building per-resource locks, the system runs **at most one conversation through the pipeline at a time**.

```
archive_conversation (MCP) ──┐
archive-transcript   (CLI) ──┼──► SequentialQueue ──► one worker ──► full pipeline
future tools               ──┘                                       (write → commit → classify → synthesize)
```

**In-process FIFO (`src/core/queue/sequential-queue.ts`).** A minimal queue with a single drain loop, used at module scope inside the MCP server. The handler for `archive_conversation` calls `queue.enqueue(() => archiveConversation(...))` and awaits its result. A failing job rejects only its own caller; the drain loop continues with the next job. Properties:

- Strict FIFO submission order.
- At most one job in flight (`maxActive === 1`).
- `queue.depth` exposed for future metrics.

**Cross-process collisions.** The CLI is a one-shot process invoked from Stop hooks, so the in-process queue does not coordinate it with a long-running MCP server. The git layer absorbs that race: `autoCommit` retries on `index.lock` errors with backoff `[50, 150, 300] ms` (3 attempts). No vault-level lockfile in Stage 1; revisit if retries start failing in practice.

**Stage-1 latency vs. Stage-2 fire-and-forget.** Today the MCP caller blocks until the full pipeline finishes; that is fine because the pipeline is just file write + git commit (milliseconds). When Stage 2 introduces LLM classification/synthesis (seconds), the MCP entry point switches to fire-and-forget: enqueue a job, return a job ID immediately, drain asynchronously. The queue itself does not change — only the moment the caller stops waiting moves earlier.

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
      sequential-queue.ts  # in-process FIFO; single drain loop
      fs-queue.ts          # Stage 2+: cross-process job queue under vault/_queue/
    git.ts             # autoCommit with index.lock retry (50/150/300 ms x3)
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
5. Cross-process git collisions — `autoCommit` retries `index.lock` 3x with backoff. If concurrent Stop hooks ever exhaust retries in practice, add a vault-level lockfile (`vault/.kh.lock` via atomic mkdir) before falling back to a filesystem queue at this layer.

## Classification: prompt I/O contract

Stage 2 classifies each entity extracted from a conversation by calling an LLM with the prompt at `src/core/llm/prompts/classify.md`. The classifier maintains the ontology — it picks the primary parent category, lists additional indexes, detects duplicates against existing entities, proposes new categories when nothing fits, and flags rebalancing actions. `pipeline/classify.ts` parses its JSON output with a zod schema in `src/core/schema.ts` and hands the decision to the executor, which either applies it or stages it under `vault/_proposals/` according to `mode`.

**Input** (constructed by `pipeline/resolve.ts`, capped at `entity_resolution.graph_max_entities` neighbors):

```jsonc
{
  "new_node": { "name": "", "summary": "", "tags": [], "aliases": [] },
  "candidate_categories": [
    { "id": "", "name": "", "summary": "", "path": [], "sibling_examples": [], "similarity_score": 0.0 }
  ],
  "candidate_entities": [
    { "id": "", "name": "", "summary": "", "aliases": [] }
  ],
  "nearby_nodes": [{ "name": "", "relation": "", "summary": "" }],
  "existing_relations": [],
  "ontology_rules": [],
  "autonomy_policy": {
    "auto_actions":     ["create_entity", "update_entity", "add_to_index"],
    "proposal_actions": ["split_category", "merge_entities", "rename_entity", "delete_page", "create_category"]
  },
  "confidence_thresholds": { "auto_min": 0.75, "propose_min": 0.45 },
  "ontology_health_signals": { "category_entropy": {}, "sibling_coherence": {}, "overloaded_categories": [] }
}
```

**Output:**

```jsonc
{
  "decision": {
    "is_duplicate_of": null,
    "primary_parent_id": "",
    "primary_parent_name": "",
    "additional_index_ids": [],
    "additional_index_names": [],
    "new_category_proposal": null,    // { name, parent_id, summary, rationale } | null
    "aliases": [],
    "secondary_relations": [
      { "target_id": "", "target_name": "", "relation": "" }
    ],
    "confidence": 0.0
  },
  "mode": "auto",                     // "auto" | "proposal"
  "reasoning": {
    "semantic_fit": "",
    "sibling_analysis": "",
    "rejected_candidates": [{ "candidate_id": "", "reason": "" }],
    "ontology_considerations": ""
  },
  "rebalancing": {
    "needed": false,
    "reasons": [],
    "actions": [{ "type": "move|split|merge|rename|create_category", "target_id": "", "details": "" }]
  },
  "warnings": []
}
```

**Field → executor action mapping:**

| Output field | Auto action (`mode=auto`) | Proposal action (`mode=proposal`) |
|---|---|---|
| `decision.primary_parent_id` + `additional_index_ids` | `add_to_index` for each | staged under `_proposals/` |
| `decision.is_duplicate_of` | link aliases on existing entity, skip create | staged under `_proposals/` |
| `decision.new_category_proposal` | — (always proposal) | staged under `_proposals/` |
| `decision.aliases` | written to entity frontmatter | — |
| `rebalancing.actions[]` (split/merge/rename/delete) | — (always proposal) | staged under `_proposals/` |

**Mode selection** is decided inside the prompt, not by the executor. The classifier sees `autonomy_policy` and `confidence_thresholds` and emits `mode` accordingly: `auto` only when confidence ≥ `auto_min`, no rebalancing is needed, and every implied action is in `auto_actions`; otherwise `proposal`. This keeps autonomy gating in one place — the prompt — instead of scattering threshold checks across the pipeline.

**Validation.** Output is parsed with a zod schema mirroring the JSON above. Schema-validation failure triggers exactly one retry with a follow-up message containing the validation error; a second failure falls back to `mode=proposal` with the raw text attached to the proposal file.

**Graph-size cap.** `pipeline/resolve.ts` pre-filters the neighborhood (keyword retrieval today, sqlite-vec later — see Deferred risks #2) so the prompt always receives a bounded slice, never the full vault graph. The 500-entity cap from `config.entity_resolution.graph_max_entities` is enforced at the resolver, not the classifier.

> Stage 2 in the *Staged build* table refers to this section — the LLM classification step is governed by the contract documented here.