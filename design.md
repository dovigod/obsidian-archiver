# AI Knowledge Hub — Implementation Design

Companion to `draft.md`. The spec describes the *what*; this document describes the *how*.

> **Architecture pivot (2026-05-17):** Nested categorization is dropped — no `categories`, no `entity_indexes`, no taxonomy graph, no rebalancing. Obsidian's **Smart Connections** plugin owns "related notes" via embeddings; Obsidian's native backlink pane owns exact references. With the ontology graph gone, **Postgres + pgvector is replaced by a single-file SQLite database** (`vault/.kh.db`). Markdown is the rendering format; SQLite is the source of truth for dedup, jobs, and the render manifest; git wraps the rendered vault for recovery.
>
> Earlier versions (2026-05-04) used Postgres with a classify/rebalance pipeline and an `_inbox/` fallback queue. Both are gone. The worker now only **extracts → dedups → rewrites → renders**.

## Tech stack

- **Language**: TypeScript
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)
- **Validation**: zod
- **Frontmatter**: gray-matter (raw-conversation md write/parse and rendered entity-md output)
- **IDs**: uuid v7 (time-ordered)
- **LLM**: pluggable provider; Claude API as initial impl
- **Database**: SQLite via `better-sqlite3`, WAL mode, single file at `<vault>/.kh.db`
- **ORM + migrations**: Drizzle (`drizzle-orm/better-sqlite3` + `drizzle-kit`)
- **Config loading**: `.env` for secrets (loaded via `dotenv`); JSON config for behavior (`~/.knowledge-hub/config.json` + per-project overrides)
- **Distribution**: `npm install -g knowledge-hub` (or `pnpm add -g`). No Docker, no compose, no Postgres. A fresh machine with Node 20 installed and the Smart Connections Obsidian plugin enabled has a working stack after `kh init <vault>`.
- **Storage roles**
  - **SQLite** (`vault/.kh.db`) — canonical: entities, aliases, conversations metadata, sources, jobs, rendered-file manifest.
  - **Filesystem (rendered vault)** — derived: `vault/knowledge/{Entity}.md`. Read-only by convention.
  - **Filesystem (raw)** — append-only: `vault/raw/conversations/YYYY/MM/{uuid7}.md`. Bulky, append-only, Obsidian-readable; stays on disk.
  - **Filesystem (proposals)** — `vault/_proposals/`. Two flavors: `raw_invalid/` (LLM output that failed schema validation) and `manual_edit/` (drift-staged user edits). Git-tracked.
  - **Git** — wraps the rendered vault for recovery (`git revert`).
  - **Smart Connections** — Obsidian plugin. Owns embeddings and "related notes" UX under `.smart-env/`. The Hub does not maintain a vectors table and does not read from `.smart-env/`.
- **Output format**: Obsidian Flavored Markdown (spec lifted from `kepano/obsidian-skills`)

## Architecture

Core library + thin adapters. Two entrypoints share one core; one SQLite file backs them all:

```
                       ┌──────────────────┐
                       │  vault/.kh.db    │
                       │  (SQLite, WAL)   │
                       └────────▲─────────┘
                                │ Drizzle / better-sqlite3
                  ┌─────────────┴─────────────┐
                  │        core (lib)         │
                  └─┬───────────────────────┬─┘
       ┌────────────┘                       └────────────┐
   bin/mcp-server                                     bin/cli
   (capture + in-process worker:                     (init, sync, status,
    extract → dedup → rewrite → render)               migrate, apply-proposal,
                                                      reconcile, backup,
                                                      restore, worker --daemon)
                                                              │
                                                              ▼
                                                vault/ (rendered md + git +
                                                       Smart Connections)
```

The MCP server is long-lived for the Claude Code session and **drains jobs in-process** — no separate worker required for the default deployment. When Claude Code isn't running, jobs sit `pending`; the next startup recovers and drains them. For always-on processing, `kh worker --daemon` runs the same in-process loop standalone.

## Config-first principle

Behavior is configurable. Config layering, in order of precedence (later wins):

1. `~/.knowledge-hub/config.json` — global defaults
2. `<project>/.knowledge-hub/config.json` — per-project overrides (deep-merged)
3. `.env` (via `dotenv`) — secrets only (`ANTHROPIC_API_KEY`)

Schema (validated by zod, defaults in code):

```jsonc
{
  "vault": { "path": "/abs/path/to/vault" },

  "storage": {
    "sqlite": {
      "path":            ".kh.db",   // relative to vault.path
      "journal_mode":    "WAL",
      "busy_timeout_ms": 5000,
      "synchronous":     "NORMAL"    // OK with WAL; "FULL" for paranoia
    }
  },

  "capture": {
    "mode": "auto",
    "sources": { "claude_code": true }
  },

  "extract": {
    "enabled":   true,
    "execution": "async",
    "llm": {
      "provider":    "claude",
      "model":       "claude-opus-4-7",
      "api_key_env": "ANTHROPIC_API_KEY"
    }
  },

  "dedup": {
    "exact": ["name", "aliases"],
    "fuzzy": {
      "engine":      "fts5",
      "min_score":   0.6,
      "top_k":       3,
      "llm_confirm": true    // when fuzzy hits exist, ask LLM to confirm
    }
  },

  "page_update_strategy": "llm_rewrite",

  "sync": {
    "mode": "auto",            // "auto" | "manual"
    "auto": {
      "strategy":    "eager",  // "eager" (per-write) | "debounced" (batched)
      "debounce_ms": 2000
    },
    "drift": {
      "detect":      true,
      "stage_under": "_proposals/manual_edit"
    }
  },

  "git": { "auto_commit": true, "commit_per_render": true },

  "ids": { "strategy": "uuid_v7" }
}
```

Subtractions from the Postgres design: no `classification.*`, no `autonomy.proposal_actions`, no `entity_resolution.graph_max_entities`, no `views.canvases.*`. All gone with the ontology.

## Knowledge model

**Source of truth is SQLite.** A small set of tables holds the canonical data; everything in `vault/knowledge/` is rendered from them.

```
entities             (id PK, name UNIQUE, summary, body_md TEXT,
                      deleted_at INTEGER NULL,                     ← soft delete (epoch)
                      created_at, updated_at, synced_at)

entity_aliases       (entity_id FK, alias, PK(entity_id, alias))

entity_aliases_fts   FTS5 virtual table over (entity_id, name, alias)
                     -- maintained by triggers on entities/entity_aliases
                     -- used for fuzzy dedup lookup

conversations        (id PK, source, model, created_at,
                      project_json, topics_json, tags_json,
                      git_repo, git_branch, git_commit, cwd,
                      raw_path)
                     -- JSON arrays stored as TEXT (SQLite has no native array)

sources              (entity_id FK, conversation_id FK,
                      PK(entity_id, conversation_id))

jobs                 (id PK, type, payload_json, state, attempts,
                      enqueued_at, started_at, lease_until,
                      finished_at, last_error)
                     -- type: 'extract' | 'rewrite' | 'render'
                     -- state: 'pending' | 'running' | 'done' | 'failed'

rendered_files       (path PK,                          ← e.g. "knowledge/Redis.md"
                      kind,                             ← 'entity' (only kind, for now)
                      source_id,                        ← entity uuid
                      last_rendered_hash BLOB,          ← for drift detection
                      last_rendered_at, synced_at)
```

**Single canonical entity per concept.** Two Redis conversations produce one `entities` row and one rendered `knowledge/Redis.md`. Wikilinks resolve to that one file.

**No `categories`, no `entity_indexes`.** Multi-categorization is replaced by tags in frontmatter + Obsidian's native filtering. Hierarchy is gone entirely.

**No `entity_relations` table.** Inline `[[wikilinks]]` in `body_md` *are* the relations. Obsidian's backlink pane surfaces them; the Hub doesn't maintain a graph.

**No `embeddings` table.** Smart Connections owns vectors under `.smart-env/`.

**No `proposals` table.** The two surviving proposal flavors (`raw_invalid`, `manual_edit`) are file-based under `vault/_proposals/` — review history lives in git, not in the DB.

### Jobs lifecycle

```
pending  ─ claim() ─►  running  ─ complete() ─►  done
                          │
                          ├─ fail() ─► failed     (after max_attempts)
                          │
                          └─ lease_until < strftime('%s','now') ─► reclaimed
```

- **Atomic claim**: `BEGIN IMMEDIATE; UPDATE jobs SET state='running', started_at=$now, lease_until=$now+$lease, attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE state='pending' ORDER BY enqueued_at LIMIT 1) RETURNING *; COMMIT;` — `BEGIN IMMEDIATE` takes a RESERVED lock so the read+update is atomic.
- **Lease deadline**: on MCP server / worker startup, `UPDATE jobs SET state='pending' WHERE state='running' AND lease_until < strftime('%s','now')` reclaims orphaned jobs from a crashed prior run.
- **Dead letter**: after `attempts >= max_attempts` (default 5), `state='failed'` with `last_error`. Retained for inspection; no auto-retry.

## Vault layout (rendered)

```
vault/
  .kh.db                              # SQLite — single-file source of truth
  .kh.db-wal                          # WAL sidecar (gitignored)
  .kh.db-shm                          # shared-memory sidecar (gitignored)

  raw/
    conversations/YYYY/MM/{uuid7}.md  # append-only raw conversation md
                                      # SQLite holds metadata; body stays on disk

  knowledge/                          # ALL FILES BELOW ARE RENDERED — DO NOT EDIT
    {Entity}.md                       # canonical entity pages (flat)

  _proposals/                         # GIT-TRACKED — review history
    raw_invalid/                      # LLM output that failed zod schema
    manual_edit/                      # from drift detection

  _backups/
    kh-{ISO}.sql.gz                   # SQLite dumps from `kh backup`

  .smart-env/                         # Smart Connections plugin state (gitignored)
```

`.gitignore` at the vault root:

```gitignore
.kh.db
.kh.db-wal
.kh.db-shm
.smart-env/
```

**`.kh.db` is gitignored.** The DB is treated as a rebuildable local cache; durable state is (a) raw conversations on disk, (b) rendered markdown in git, (c) periodic `.sql.gz` dumps under `_backups/`. Committing a binary blob doesn't diff well and bloats the repo; the dump matches the original `kh backup` story.

### Banner on rendered files

Each rendered md file carries a banner so users opening one in Obsidian know not to hand-edit:

```markdown
<!-- ⚠️  Generated from .kh.db by `kh sync`. Hand edits are detected and
     staged under _proposals/manual_edit/ on the next sync. -->
---
id: ...
name: ...
...
---
# Redis

...
```

> **Implementation note**: gray-matter expects YAML frontmatter to be the first content. Verify with a unit test that an HTML comment ahead of `---` parses cleanly. If it doesn't, fall back to either (a) a YAML comment line `# Generated by kh sync — do not edit` *inside* the frontmatter, or (b) the banner as the first line of body content immediately after the `# {Name}` H1.

## Page-update strategy: LLM-rewrite

When new content arrives for an existing entity, the system passes the existing entity body + new conversation excerpt to the LLM and writes back an integrated rewrite:

1. `UPDATE entities SET body_md = $rewrite, updated_at = $now`.
2. Renderer regenerates `{Entity}.md`.
3. `synced_at` bumped on the `rendered_files` row immediately after that file is written (per-file, not per-batch — keeps the renderer crash-safe and idempotent).
4. Git auto-commit per render (`git.commit_per_render = true`) or batched (`false`).

"Preserve existing facts unless contradicted" framing in the rewrite prompt. Token-budget cap with summarize-older-sections fallback as bodies grow.

## Capture modes

- **Auto** — Claude Code Stop hook invokes `kh archive-transcript`. Hook never blocks Claude (exits 0 on failure).
- **Manual** — user calls `archive_conversation` MCP tool from within a Claude Code session.

Both routes:

```
archive_conversation / archive-transcript
        │
        ▼
   Write raw md to vault/raw/conversations/YYYY/MM/{uuid7}.md
        │
        ▼
   BEGIN IMMEDIATE
     INSERT conversations row
     INSERT jobs(type='extract', payload={conversation_id})
   COMMIT
        │
        ▼
   return success (synthesize id back to caller)
```

SQLite is local — if the DB file is unreachable, the disk is gone. There is no `_inbox/` fallback queue in this design; on `SQLITE_BUSY` past `busy_timeout_ms` we retry once and then log to stderr and exit 0. The raw md is **already on disk**, so `kh reconcile` (see "Failure modes") can rebuild the missing `conversations` row from the file later.

### Startup recovery

On MCP server / worker startup, one query reclaims orphaned jobs:

```sql
UPDATE jobs SET state='pending'
WHERE state='running' AND lease_until < strftime('%s','now')
```

Then the drain loop runs. No `_inbox/` to reconcile against.

## Concurrency

SQLite in **WAL mode** allows concurrent readers + one writer. For a single-user desktop tool with one MCP server, one CLI invocation, and the worker all sharing `vault/.kh.db`, this is sufficient. `busy_timeout_ms` (5000ms default) means concurrent writers wait rather than error.

`SequentialQueue` is **kept inside the worker** to linearize the per-conversation Stage 2 pipeline (extract → dedup → rewrite → render). Without it, two conversations processed in parallel could race on the same entity row and produce conflicting rewrites.

```
worker drain loop:
  for each claimed job:
    queue.enqueue(() => stage2Pipeline(conversation))
```

**Cross-process git collisions** (multiple processes committing rendered files) are absorbed by `autoCommit`'s `index.lock` retry (`[50, 150, 300] ms` × 3).

## Sync (SQLite → vault)

The rendered vault is regenerated from SQLite on a configurable schedule.

| Mode | Renderer triggered by | Vault freshness | Run by |
|---|---|---|---|
| `auto.strategy=eager` | Synchronously after every entity write | Always current | In-process worker (post-commit hook in `executeDecision`) |
| `auto.strategy=debounced` | Timer in the worker; coalesces writes within `debounce_ms` | ≤ debounce window stale | In-process worker |
| `manual` | `kh sync` CLI invocation | Stale until command | CLI subprocess |

`pipeline/render.ts` reads dirty rows and regenerates the affected files:

```
dirty entities    = entities WHERE updated_at > synced_at AND deleted_at IS NULL
deleted entities  = entities WHERE deleted_at IS NOT NULL AND deleted_at > synced_at
```

**Per-file `synced_at` bump.** After each file write, `UPDATE rendered_files SET last_rendered_at=$now, last_rendered_hash=$hash WHERE path=$path`. The renderer is idempotent: if it crashes mid-batch, re-running picks up exactly where it left off.

**Deletes.** `entities.deleted_at IS NOT NULL` triggers file removal:

```
rm vault/knowledge/{Entity}.md
DELETE FROM rendered_files WHERE source_id = entity.id
git add -A && git commit -m "delete(${entity.name})"
```

### CLI

```
kh init <vault>            # create vault dirs, .kh.db, run migrations, scaffold .gitignore
kh sync                    # render all dirty entities → md + git commit
kh sync --entity Redis     # render one entity
kh sync --since 2026-05-01 # everything updated since date
kh sync --full             # rebuild ALL md from SQLite (fresh checkout)
kh sync --dry-run          # show what would change
kh status                  # entities pending sync, jobs pending
kh apply-proposal <id>     # accept a staged manual_edit / raw_invalid
kh reconcile               # walk raw/conversations/, re-enqueue extract for orphans
kh backup                  # SQLite .backup → vault/_backups/kh-{ISO}.sql.gz
kh restore <path>          # gunzip | sqlite3 .kh.db
kh worker --daemon         # always-on background drain (optional)
kh migrate                 # apply pending Drizzle migrations
```

### Drift detection

Before overwriting a rendered file, the renderer hashes its current contents and compares against `rendered_files.last_rendered_hash`:

```
hash mismatch on knowledge/Redis.md
   → copy current file to _proposals/manual_edit/{uuid7}.md
   → proceed with the regular render (does NOT discard the staged copy)
```

The user reviews the staged edit later via `kh apply-proposal` (or by hand) and either ports it back into SQLite or discards it. `sync.drift.detect = false` skips the check.

## Stage 2 pipeline: extract → dedup → rewrite → render

The classifier and rebalancer from the Postgres design are gone. The worker pipeline is now:

```
extract (LLM)
  → returns: [{ name, summary, aliases, draft_body, tags }]

  for each candidate entity:
    exact match on entities.name or entity_aliases.alias?
       yes → queue 'rewrite' job for that entity
       no  → FTS5 query against entity_aliases_fts (top_k from config.dedup.fuzzy.top_k)
              hits above min_score?
                 yes → 'dedup-confirm' LLM call:
                          "Are any of these the same entity? Return id or null."
                        → if id returned: queue 'rewrite' job
                        → if null:        INSERT new entity + queue 'render' job
                 no  → INSERT new entity + queue 'render' job

rewrite (LLM)
  → existing body + new conversation excerpt → integrated body
  → UPDATE entities SET body_md = $rewrite, updated_at = $now
  → queue 'render' job

render
  → write vault/knowledge/{Entity}.md
  → UPDATE rendered_files SET last_rendered_hash = $hash, last_rendered_at = $now
  → git auto-commit (if enabled)
```

### Extract prompt I/O

**Input:** the conversation excerpt + a small list of recent entity names (for naming-style context, not classification).

**Output schema** (zod-validated):

```jsonc
{
  "entities": [
    {
      "name":       "Redis",
      "summary":    "In-memory key-value store…",
      "aliases":    ["redis", "Redis Cache"],
      "draft_body": "...markdown...",
      "tags":       ["database", "cache"]
    }
  ]
}
```

### Dedup-confirm prompt I/O

Only invoked when FTS5 returns at least one hit above `min_score`.

**Input:**

```jsonc
{
  "new_node":   { "name": "Redis Cache", "summary": "…", "aliases": ["redis"] },
  "candidates": [
    { "id": "0192…", "name": "Redis", "summary": "…", "aliases": ["redis"] }
  ]
}
```

**Output:**

```jsonc
{ "match_id": "0192…" }   // or { "match_id": null }
```

### Rewrite prompt

Pass `existing body + new excerpt` to the LLM; write back an integrated rewrite. "Preserve existing facts unless contradicted." Token-budget cap with summarize-older-sections fallback as bodies grow.

### Validation

All LLM outputs parsed against zod. Schema-validation failure → one retry with the validation error appended to the prompt; a second failure → stage the raw text as a `raw_invalid` proposal under `vault/_proposals/raw_invalid/{uuid7}.md`. The Stage 2 pipeline moves on; the entity is left unprocessed for that conversation.

## Failure modes

### SQLite locked / corrupted

| Surface | Behavior |
|---|---|
| Stop hook / `archive-transcript` | If `SQLITE_BUSY` after `busy_timeout_ms`, retry once. If still failing, log to stderr and exit 0 — the hook never blocks Claude. The raw md is **already on disk**; `kh reconcile` rebuilds the missing `conversations` row + extract job. |
| MCP `archive_conversation` | Same as above; return a synthetic id and continue. |
| Worker draining jobs | Standard retry with exponential backoff. Persistent corruption escalates to `failed` state for inspection. |
| `kh sync` | Fails fast with the underlying error. |

### Drift on rendered files

See "Drift detection". Hand-edits are preserved as proposals, never silently overwritten.

### Renderer crash mid-batch

`rendered_files.last_rendered_at` + `last_rendered_hash` are bumped *per file*, immediately after each successful write. Crash after 50 of 100 → those 50 are recorded as synced; the remaining 50 are still dirty. Re-running resumes. **Never** bump `synced_at` for a batch you haven't actually written.

### Schema validation failure

Single retry with error feedback in the prompt; second failure stages a `raw_invalid` proposal.

### Cross-process git collisions

`autoCommit` retries `index.lock` errors `[50, 150, 300] ms` × 3. If retries are exhausted in practice, escalate to a vault-level lockfile (`vault/.kh.lock` via atomic mkdir).

### Reconciliation

`kh reconcile` walks `vault/raw/conversations/**` and ensures every file has a corresponding `conversations` row, re-enqueuing extract jobs for any orphans. This is the recovery story for:

- "I deleted `.kh.db` by accident"
- "SQLite was locked during a capture and the row never got written"
- Fresh clone of the vault without the (gitignored) `.kh.db`

The reconciled state is lossless for *raw* conversations — rendered entity bodies may need LLM re-rewrite, which costs API time but produces equivalent output.

### Backup / restore

```
kh backup                  # uses SQLite Online Backup API; gzip → vault/_backups/kh-{ISO}.sql.gz
                           # tracked in git so cloning the vault includes it
kh restore <path>          # gunzip | sqlite3 .kh.db
```

Recovery story: clone vault → `kh restore vault/_backups/kh-latest.sql.gz` → done. If no backup exists, `kh reconcile` rebuilds from raw md (LLM cost, no raw-data loss).

## Migrations

- Tool: **Drizzle** (`drizzle-orm/better-sqlite3` for schema declarations and runtime queries; `drizzle-kit` for SQLite migration generation).
- Migrations live under `drizzle/` (auto-generated SQL files + `drizzle.config.ts`).
- `drizzle-kit generate` produces a new migration when schema changes; `drizzle-kit migrate` (or `kh migrate`) applies them.
- Schema in `src/core/db/schema.ts`; query helpers in `src/core/db/repository/*.ts`.
- FTS5 virtual table + triggers are created in the first migration.
- Forward-only; rollback by writing a corrective migration.
- Migrations applied automatically on MCP server / worker startup (controlled by `--no-auto-migrate` flag for operators who want explicit control).

## Distribution

```sh
pnpm add -g knowledge-hub        # or: npm install -g knowledge-hub
kh init ~/my-vault               # creates dirs, .kh.db, .gitignore, initial commit
```

Then add to Claude Code MCP config:

```jsonc
{
  "mcpServers": {
    "knowledge-hub": {
      "command": "kh-mcp",
      "args":    ["--vault", "/Users/me/my-vault"]
    }
  }
}
```

Smart Connections is installed inside Obsidian (Community Plugins → Smart Connections). It indexes `vault/knowledge/` independently — the Hub doesn't talk to it and doesn't depend on it for correctness; it's purely an Obsidian-side discovery UX.

The Hub ships as a single npm package with two binaries:

- `kh-mcp` — stdio MCP server (capture + in-process worker)
- `kh` — CLI (`init`, `sync`, `status`, `migrate`, `apply-proposal`, `reconcile`, `backup`, `restore`, `worker`)

No Docker. No Postgres. No long-running services beyond what the user opts into via `kh worker --daemon`.

## Staged build

| Stage | Output | Exit criterion |
|---|---|---|
| 1 | Raw archive: `conversations` row + raw md on disk | Claude Code session produces a `conversations` row pointing at `vault/raw/conversations/.../*.md` |
| 2 | Entity rows via LLM extract + dedup (FTS5 + optional LLM confirm); LLM-rewrite of bodies; rendered `Redis.md` derived from one row | Two Redis conversations produce one `entities` row and one rendered `knowledge/Redis.md` integrating both, with `[[wikilink]]` backlinks resolving |
| 3 | Sync polish — drift detection, deletes propagate, idempotent re-renders, `kh reconcile`, `kh backup`/`restore` | Hand-edit on `Redis.md` stages a `manual_edit` proposal; delete propagates; renderer crash-then-resume; deleted `.kh.db` rebuilt from raw md |
| 4 | Smart Connections integration polish — `kh init` recommends the plugin; document recommended Smart Connections settings | Smart Connections surfaces semantically related entities in the Obsidian sidebar without Hub intervention |
| 5 | Additional capture sources (backfill scraper, other AI tools), import/export, optional advanced dedup (e.g. borrow Smart Connections' index for higher-recall dedup) | Out of scope until 1–4 stable |

## Target repo layout

```
src/
  core/
    config.ts          # zod-validated global+project+env config loader
    schema.ts          # Conversation, ExtractInput/Output, DedupInput/Output, etc.
    ids.ts
    normalize.ts
    transcript.ts      # Claude Code JSONL → Conversation
    db/
      client.ts        # better-sqlite3 client (WAL mode, busy_timeout)
      schema.ts        # Drizzle schema (entities, aliases, jobs, rendered_files, …)
      repository/
        entities.ts
        conversations.ts
        jobs.ts
        rendered_files.ts
    repository/
      raw.ts           # MarkdownVaultRepository — raw conversation md
      proposals.ts     # _proposals/ md/JSON files
    llm/
      provider.ts
      claude.ts
      mock.ts
      prompts/
        obsidian-markdown.md
        extract.md
        dedup.md
        rewrite.md
    pipeline/
      extract.ts
      dedup.ts         # FTS5 lookup + optional LLM confirm
      rewrite.ts       # LLM body integration
      execute.ts       # writes to SQLite; triggers render in eager mode
      render.ts        # SQLite → md vault
      reindex.ts       # full re-render
      reconcile.ts     # walk raw/conversations/, ensure conversations rows
      run.ts           # Stage 2 orchestration
    queue/
      sequential-queue.ts  # in-process FIFO; used inside the worker
      sqlite-queue.ts      # SQLite-backed jobs (claim/lease/recover)
    git.ts             # autoCommit with index.lock retry
  bin/
    mcp-server.ts      # stdio MCP — exposes archive_conversation; runs worker in-process
    cli.ts             # subcommands: init, archive-transcript, worker, sync,
                       #              status, migrate, apply-proposal,
                       #              reconcile, backup, restore

drizzle/
  meta/
  0000_initial.sql       # schema + FTS5 virtual table + triggers
  …
drizzle.config.ts

.gitignore               # .kh.db*, .smart-env/, node_modules, dist, .env
test/
package.json
tsconfig.json
```

## External references

- Spec source: `draft.md`
- `kepano/obsidian-skills` (MIT) — https://github.com/kepano/obsidian-skills
  - `obsidian-markdown` → inlined into rewrite prompts (with license header)
- MCP SDK — https://github.com/modelcontextprotocol/typescript-sdk
- Drizzle ORM — https://orm.drizzle.team/
- better-sqlite3 — https://github.com/WiseLibs/better-sqlite3
- SQLite WAL mode — https://www.sqlite.org/wal.html
- SQLite FTS5 — https://www.sqlite.org/fts5.html
- Smart Connections (Obsidian plugin) — https://github.com/brianpetro/obsidian-smart-connections

## Deferred risks (not blockers)

1. **SQLite single-writer.** WAL mode handles single-user fine; multi-process write contention is bounded by `busy_timeout_ms`. If the Hub ever needs concurrent writers across machines, that's the trigger to revisit Postgres.
2. **Schema migration discipline.** Forward-only migrations require care (no destructive rewrites). Lean on Drizzle's generator; CI runs `drizzle-kit migrate` against a fresh `.kh.db` before tests.
3. **Render throughput at scale.** `eager` mode writes a file + commits per entity write. At very high write rates, switch to `debounced` or `manual`. Renderer is incremental — only touches dirty rows.
4. **Backup discipline.** SQLite-as-truth means losing `.kh.db` without a backup forces a `kh reconcile` (LLM cost to re-extract). `kh backup` produces a checkpoint under `vault/_backups/`. Recommend a daily cron / hook; not enforced.
5. **Renderer crash idempotency.** Per-file `synced_at` bumps must happen *immediately after* each successful write, not at end-of-batch. Tests cover the crash-then-resume case.
6. **CI infra for DB-touching tests.** Trivial with SQLite — every test gets its own `.kh.db` in a tmpdir; no service to spin up.
7. **Drift policy ambiguity.** If a rendered file is edited multiple times before a sync, only the latest hand-edit is staged. Single-user assumption holds for the MVP.
8. **Page identity stability.** Entity-name filenames are MVP; restructuring carries link-rewrite. Switch to uuid-based filenames if rename churn becomes a problem.
9. **LLM-rewrite quality.** Heavy reliance on prompt engineering; mitigated by mandatory git auto-commit on rendered files.
10. **Dedup recall.** FTS5 + LLM confirm is cheaper than a full classifier but can miss synonyms ("k/v store" vs "Redis"). If recall becomes a problem, revisit by either (a) borrowing Smart Connections' index for higher-recall candidate lookup, or (b) maintaining a small embeddings table just for dedup.
11. **Smart Connections coupling.** "Related" UX depends on a third-party Obsidian plugin. Mitigated by the fact that the Hub doesn't read from Smart Connections — if it disappears, the vault still renders; users just lose semantic discovery and fall back to native backlinks + tag search.
