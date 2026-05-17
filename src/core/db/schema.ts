import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Canonical entity row. One per concept. Bodies live here directly
 * (SQLite has no TOAST pressure; no separate `entity_body` table).
 *
 * `deleted_at` is a soft-delete timestamp (epoch ms). Renderer removes
 * the matching md file when this is set.
 */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    summary: text("summary").notNull().default(""),
    bodyMd: text("body_md").notNull().default(""),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    syncedAt: integer("synced_at"),
  },
  (t) => ({
    deletedAtIdx: index("idx_entities_deleted_at").on(t.deletedAt),
    updatedAtIdx: index("idx_entities_updated_at").on(t.updatedAt),
  }),
);

/** Synonyms / alternate spellings for dedup lookup. */
export const entityAliases = sqliteTable(
  "entity_aliases",
  {
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entityId, t.alias] }),
  }),
);

/**
 * Conversation metadata. Body stays on disk under
 * `vault/raw/conversations/YYYY/MM/{id}.md`; `rawPath` points at it
 * (vault-relative).
 *
 * Array fields are stored as JSON strings — SQLite has no native array.
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    model: text("model"),
    createdAt: integer("created_at").notNull(),
    projectJson: text("project_json").notNull().default("[]"),
    topicsJson: text("topics_json").notNull().default("[]"),
    conversationTypeJson: text("conversation_type_json")
      .notNull()
      .default("[]"),
    tagsJson: text("tags_json").notNull().default("[]"),
    gitRepo: text("git_repo"),
    gitBranch: text("git_branch"),
    gitCommit: text("git_commit"),
    cwd: text("cwd"),
    rawPath: text("raw_path").notNull(),
    /** sha256 over normalized messages for backfill idempotency (Stage 5). */
    contentHash: text("content_hash"),
  },
  (t) => ({
    contentHashIdx: index("idx_conversations_content_hash").on(t.contentHash),
  }),
);

/** entity ⇄ conversation provenance link. */
export const sources = sqliteTable(
  "sources",
  {
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entityId, t.conversationId] }),
  }),
);

/**
 * Async job queue. Claim via `BEGIN IMMEDIATE; UPDATE ... WHERE id = (...)`.
 * `leaseUntil` is the wall-clock deadline (epoch ms) after which a stuck
 * `running` job is reclaimed on the next worker startup.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    enqueuedAt: integer("enqueued_at").notNull(),
    startedAt: integer("started_at"),
    leaseUntil: integer("lease_until"),
    finishedAt: integer("finished_at"),
    lastError: text("last_error"),
  },
  (t) => ({
    stateEnqIdx: index("idx_jobs_state_enqueued").on(t.state, t.enqueuedAt),
    stateLeaseIdx: index("idx_jobs_state_lease").on(t.state, t.leaseUntil),
  }),
);

/**
 * Manifest of files written into the rendered vault. Drift detection
 * compares the current on-disk hash against `lastRenderedHash`. Re-render
 * picks up rows where `lastRenderedAt` is null or stale relative to the
 * underlying source row.
 */
export const renderedFiles = sqliteTable(
  "rendered_files",
  {
    path: text("path").primaryKey(),
    kind: text("kind").notNull(),
    sourceId: text("source_id").notNull(),
    lastRenderedHash: blob("last_rendered_hash"),
    lastRenderedAt: integer("last_rendered_at"),
    syncedAt: integer("synced_at"),
  },
  (t) => ({
    sourceIdx: index("idx_rendered_files_source").on(t.sourceId),
    dirtyIdx: index("idx_rendered_files_dirty").on(t.lastRenderedAt),
  }),
);

/**
 * Optional embeddings used by the Stage 5 advanced-dedup path. One row per
 * entity, populated by the `embed` worker job; gated by config — when
 * `dedup.fuzzy.embeddings.enabled` is false, this table stays empty.
 */
export const dedupEmbeddings = sqliteTable(
  "dedup_embeddings",
  {
    entityId: text("entity_id")
      .primaryKey()
      .references(() => entities.id, { onDelete: "cascade" }),
    vector: blob("vector").notNull(),
    dims: integer("dims").notNull(),
    model: text("model").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    modelIdx: index("idx_dedup_embeddings_model").on(t.model),
  }),
);

/* Drizzle row types — suffixed `Row` to avoid colliding with the parsed/in-memory
 * shapes in `src/core/schema.ts` (e.g. `Conversation`, `Source` enum). */
export type EntityRow = typeof entities.$inferSelect;
export type DedupEmbeddingRow = typeof dedupEmbeddings.$inferSelect;
export type NewDedupEmbeddingRow = typeof dedupEmbeddings.$inferInsert;
export type NewEntityRow = typeof entities.$inferInsert;
export type EntityAliasRow = typeof entityAliases.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
export type SourceRow = typeof sources.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type RenderedFileRow = typeof renderedFiles.$inferSelect;
export type NewRenderedFileRow = typeof renderedFiles.$inferInsert;

export type JobState = "pending" | "running" | "done" | "failed";
export type JobType = "extract" | "rewrite" | "render";
export type RenderedFileKind = "entity";
