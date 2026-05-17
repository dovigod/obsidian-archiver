import { eq, isNull, or, sql } from "drizzle-orm";
import type { DB } from "@core/db/client";
import {
  renderedFiles,
  type NewRenderedFileRow,
  type RenderedFileKind,
  type RenderedFileRow,
} from "@core/db/schema";

export interface UpsertRenderedFileInput {
  path: string;
  kind: RenderedFileKind;
  sourceId: string;
  hash?: Buffer | null;
  renderedAt?: number;
}

export class RenderedFilesRepository {
  constructor(private readonly db: DB) {}

  findByPath(path: string): RenderedFileRow | undefined {
    return this.db
      .select()
      .from(renderedFiles)
      .where(eq(renderedFiles.path, path))
      .get();
  }

  /**
   * Record a successful render. Inserts on first encounter or updates the
   * manifest row in place. Called *immediately after* each file write so a
   * mid-batch crash leaves accurate state for the next run.
   */
  recordRender(input: UpsertRenderedFileInput): void {
    const now = input.renderedAt ?? Date.now();
    const values: NewRenderedFileRow = {
      path: input.path,
      kind: input.kind,
      sourceId: input.sourceId,
      lastRenderedHash: input.hash ?? null,
      lastRenderedAt: now,
      syncedAt: now,
    };
    this.db
      .insert(renderedFiles)
      .values(values)
      .onConflictDoUpdate({
        target: renderedFiles.path,
        set: {
          kind: values.kind,
          sourceId: values.sourceId,
          lastRenderedHash: values.lastRenderedHash,
          lastRenderedAt: values.lastRenderedAt,
          syncedAt: values.syncedAt,
        },
      })
      .run();
  }

  delete(path: string): void {
    this.db.delete(renderedFiles).where(eq(renderedFiles.path, path)).run();
  }

  listForSource(sourceId: string): RenderedFileRow[] {
    return this.db
      .select()
      .from(renderedFiles)
      .where(eq(renderedFiles.sourceId, sourceId))
      .all();
  }

  /**
   * Force a re-render by NULL-ing the `last_rendered_at` sentinel. Used when
   * an entity's category membership changes and its index page needs
   * regenerating even though the entity row itself wasn't touched.
   */
  markDirty(path: string): void {
    this.db
      .update(renderedFiles)
      .set({ lastRenderedAt: null })
      .where(eq(renderedFiles.path, path))
      .run();
  }

  /**
   * Rows whose underlying source row was updated more recently than the
   * last render — or that have never been rendered.
   */
  listDirty(): RenderedFileRow[] {
    return this.db
      .select()
      .from(renderedFiles)
      .where(
        or(
          isNull(renderedFiles.lastRenderedAt),
          sql`EXISTS (
            SELECT 1 FROM entities e
            WHERE e.id = ${renderedFiles.sourceId}
              AND e.updated_at > ${renderedFiles.lastRenderedAt}
          )`,
        ),
      )
      .all();
  }
}
