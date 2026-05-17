import { describe, expect, it } from "vitest";
import { MockEmbeddingsProvider } from "@core/embeddings/mock";
import { cosineSimilarity } from "@core/embeddings/provider";

describe("MockEmbeddingsProvider", () => {
  it("produces stable, deterministic vectors", async () => {
    const m = new MockEmbeddingsProvider();
    const a = await m.embed("Redis is an in-memory key-value store");
    const b = await m.embed("Redis is an in-memory key-value store");
    expect(a.length).toBe(m.dims);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("synonym pairs score higher than unrelated pairs", async () => {
    const m = new MockEmbeddingsProvider();
    const redis = await m.embed("Redis in-memory key-value store");
    const redisAlias = await m.embed("redis-server cache database");
    const unrelated = await m.embed("kubernetes pod scheduler workload");

    const simSynonym = cosineSimilarity(redis, redisAlias);
    const simUnrelated = cosineSimilarity(redis, unrelated);

    expect(simSynonym).toBeGreaterThan(simUnrelated);
  });

  it("L2-normalizes vectors", async () => {
    const m = new MockEmbeddingsProvider();
    const v = await m.embed("anything");
    let norm = 0;
    for (const x of v) {norm += x * x;}
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });
});
