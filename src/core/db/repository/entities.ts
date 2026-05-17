import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "@core/db/client";
import {
  entities,
  entityAliases,
  sources,
  type EntityRow,
} from "@core/db/schema";

export interface CreateEntityInput {
  id: string;
  name: string;
  summary?: string;
  bodyMd?: string;
  aliases?: readonly string[];
  /** Epoch ms. Defaults to `Date.now()`. */
  now?: number;
}

export interface UpdateEntityBodyInput {
  id: string;
  bodyMd: string;
  summary?: string;
  now?: number;
}

export interface FuzzyMatch {
  entityId: string;
  term: string;
  /** FTS5 BM25 score — lower is better; we expose it for callers that care. */
  score: number;
}

export class EntitiesRepository {
  constructor(private readonly db: DB) {}

  create(input: CreateEntityInput): EntityRow {
    const now = input.now ?? Date.now();
    const row = this.db.transaction((tx) => {
      const inserted = tx
        .insert(entities)
        .values({
          id: input.id,
          name: input.name,
          summary: input.summary ?? "",
          bodyMd: input.bodyMd ?? "",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      const seen = new Set<string>();
      for (const alias of input.aliases ?? []) {
        const trimmed = alias.trim();
        if (!trimmed || seen.has(trimmed)) {
          continue;
        }
        seen.add(trimmed);
        tx.insert(entityAliases)
          .values({ entityId: input.id, alias: trimmed })
          .onConflictDoNothing()
          .run();
      }
      return inserted;
    });
    return row;
  }

  updateBody(input: UpdateEntityBodyInput): void {
    // Ensure strict monotonicity: when the previous `markSynced` ran in the
    // same millisecond, `Date.now()` can equal `synced_at`, leaving the row
    // not-dirty for the renderer. Bump past `syncedAt` when that happens.
    const requested = input.now ?? Date.now();
    const existing = this.db
      .select({ syncedAt: entities.syncedAt })
      .from(entities)
      .where(eq(entities.id, input.id))
      .get();
    const now =
      existing?.syncedAt !== null &&
      existing?.syncedAt !== undefined &&
      requested <= existing.syncedAt
        ? existing.syncedAt + 1
        : requested;
    this.db
      .update(entities)
      .set({
        bodyMd: input.bodyMd,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        updatedAt: now,
      })
      .where(eq(entities.id, input.id))
      .run();
  }

  markSynced(id: string, at?: number): void {
    this.db
      .update(entities)
      .set({ syncedAt: at ?? Date.now() })
      .where(eq(entities.id, id))
      .run();
  }

  softDelete(id: string, at?: number): void {
    const ts = at ?? Date.now();
    this.db
      .update(entities)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(eq(entities.id, id))
      .run();
  }

  findById(id: string): EntityRow | undefined {
    return this.db
      .select()
      .from(entities)
      .where(eq(entities.id, id))
      .get();
  }

  findByName(name: string): EntityRow | undefined {
    return this.db
      .select()
      .from(entities)
      .where(eq(entities.name, name))
      .get();
  }

  /** Exact alias match. Returns the underlying entity. */
  findByExactAlias(alias: string): EntityRow | undefined {
    return this.db
      .select({
        id: entities.id,
        name: entities.name,
        summary: entities.summary,
        bodyMd: entities.bodyMd,
        deletedAt: entities.deletedAt,
        createdAt: entities.createdAt,
        updatedAt: entities.updatedAt,
        syncedAt: entities.syncedAt,
      })
      .from(entityAliases)
      .innerJoin(entities, eq(entities.id, entityAliases.entityId))
      .where(eq(entityAliases.alias, alias))
      .get();
  }

  listAliases(entityId: string): string[] {
    const rows = this.db
      .select({ alias: entityAliases.alias })
      .from(entityAliases)
      .where(eq(entityAliases.entityId, entityId))
      .all();
    return rows.map((r) => r.alias);
  }

  addAliases(entityId: string, aliases: readonly string[]): void {
    const seen = new Set<string>();
    for (const alias of aliases) {
      const trimmed = alias.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      this.db
        .insert(entityAliases)
        .values({ entityId, alias: trimmed })
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * FTS5 lookup. Returns top-K matches scored by BM25. Caller filters by
   * `min_score` (translated to a max BM25 threshold) and passes survivors to
   * the dedup-confirm prompt.
   *
   * FTS5 quotes the query to prevent operator-injection from user content
   * (alias-like terms can contain reserved characters like `:` or `-`).
   */
  searchFuzzy(rawQuery: string, topK: number): FuzzyMatch[] {
    const query = ftsQuote(rawQuery);
    if (!query) {
      return [];
    }
    // bm25() returns lower-is-better; we expose the absolute value as `score`
    // and sort ascending.
    const rows = this.db.all<{
      entity_id: string;
      term: string;
      score: number;
    }>(sql`
      SELECT entity_id, term, bm25(entity_terms_fts) AS score
      FROM entity_terms_fts
      WHERE entity_terms_fts MATCH ${query}
      ORDER BY score ASC
      LIMIT ${topK}
    `);
    return rows.map((r) => ({
      entityId: r.entity_id,
      term: r.term,
      score: r.score,
    }));
  }

  /** Entities whose body changed since the last successful render. */
  listDirty(): EntityRow[] {
    return this.db
      .select()
      .from(entities)
      .where(
        and(
          isNull(entities.deletedAt),
          // updated_at > synced_at  (treat null synced_at as "never rendered")
          sql`(${entities.syncedAt} IS NULL OR ${entities.updatedAt} > ${entities.syncedAt})`,
        ),
      )
      .all();
  }

  /** Entities soft-deleted since their last sync. */
  listDeletedSinceSync(): EntityRow[] {
    return this.db
      .select()
      .from(entities)
      .where(
        and(
          isNotNull(entities.deletedAt),
          sql`(${entities.syncedAt} IS NULL OR ${entities.deletedAt} > ${entities.syncedAt})`,
        ),
      )
      .all();
  }

  listAll(): EntityRow[] {
    return this.db
      .select()
      .from(entities)
      .where(isNull(entities.deletedAt))
      .all();
  }

  countAll(): number {
    const row = this.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(entities)
      .where(isNull(entities.deletedAt))
      .get();
    return row?.c ?? 0;
  }

  addSource(entityId: string, conversationId: string): void {
    this.db
      .insert(sources)
      .values({ entityId, conversationId })
      .onConflictDoNothing()
      .run();
  }

  listConversationIdsForEntity(entityId: string): string[] {
    const rows = this.db
      .select({ id: sources.conversationId })
      .from(sources)
      .where(eq(sources.entityId, entityId))
      .all();
    return rows.map((r) => r.id);
  }

  /** For reconcile: entities most recently updated. */
  listRecentlyUpdated(sinceMs: number): EntityRow[] {
    return this.db
      .select()
      .from(entities)
      .where(gt(entities.updatedAt, sinceMs))
      .all();
  }
}

/**
 * Sanitize FTS5 MATCH input. FTS5 has its own query syntax (operators like
 * `AND`, `OR`, `NEAR`, parentheses, column filters `col:term`, etc.) — passing
 * raw user content can either parse as operators or error.
 *
 * Strategy: tokenize on non-alphanumeric, drop empty tokens, wrap each token
 * in double-quotes (which makes it a literal), then join with implicit AND.
 * For OR-like recall, callers can pass " OR " between terms before calling.
 */
function ftsQuote(input: string): string {
  const tokens = input
    .replace(/["]/g, "")
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
