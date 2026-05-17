import { eq, sql } from "drizzle-orm";
import type { DB } from "@core/db/client";
import {
  type DedupEmbeddingRow,
  dedupEmbeddings,
} from "@core/db/schema";
import {
  cosineSimilarity,
  packVector,
  unpackVector,
} from "@core/embeddings/provider";

export interface UpsertDedupEmbeddingInput {
  entityId: string;
  vector: Float32Array;
  model: string;
}

export interface NearestNeighbor {
  entityId: string;
  score: number;
}

export class DedupEmbeddingsRepository {
  constructor(private readonly db: DB) {}

  upsert(input: UpsertDedupEmbeddingInput): void {
    const now = Date.now();
    const blob = packVector(input.vector);
    this.db
      .insert(dedupEmbeddings)
      .values({
        entityId: input.entityId,
        vector: blob,
        dims: input.vector.length,
        model: input.model,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: dedupEmbeddings.entityId,
        set: {
          vector: blob,
          dims: input.vector.length,
          model: input.model,
          updatedAt: now,
        },
      })
      .run();
  }

  findByEntity(entityId: string): DedupEmbeddingRow | undefined {
    return this.db
      .select()
      .from(dedupEmbeddings)
      .where(eq(dedupEmbeddings.entityId, entityId))
      .get();
  }

  /**
   * Linear-scan nearest-neighbor lookup. Fine up to ~50k entities; revisit
   * when scale demands an extension like sqlite-vec.
   */
  nearest(
    probe: Float32Array,
    topK: number,
    minCosine: number,
    model?: string,
  ): NearestNeighbor[] {
    const rows = (
      model
        ? this.db
            .select()
            .from(dedupEmbeddings)
            .where(eq(dedupEmbeddings.model, model))
            .all()
        : this.db.select().from(dedupEmbeddings).all()
    ) as DedupEmbeddingRow[];

    const scored: NearestNeighbor[] = [];
    for (const row of rows) {
      const vec = unpackVector(row.vector as Buffer);
      if (vec.length !== probe.length) {continue;}
      const score = cosineSimilarity(probe, vec);
      if (score >= minCosine) {
        scored.push({ entityId: row.entityId, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  count(): number {
    const row = this.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(dedupEmbeddings)
      .get();
    return row?.c ?? 0;
  }
}
