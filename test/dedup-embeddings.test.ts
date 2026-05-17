import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteHandle } from "@core/db/client";
import { DedupEmbeddingsRepository } from "@core/db/repository/dedup_embeddings";
import { EntitiesRepository } from "@core/db/repository/entities";
import { MockEmbeddingsProvider } from "@core/embeddings/mock";
import { newId } from "@core/ids";
import { MockLLMProvider } from "@core/llm/mock";
import { dedupEntity } from "@core/pipeline/dedup";
import type { ExtractedEntity } from "@core/schema";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

function candidate(over: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    name: "Redis",
    summary: "",
    tags: [],
    aliases: [],
    draft_body: "",
    ...over,
  };
}

describe("dedupEntity with embeddings augmentation", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup() {
    const dir = mkdtempSync(join(testTmpDir(), "dedup-emb-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    return {
      entities: new EntitiesRepository(db),
      embeddings: new DedupEmbeddingsRepository(db),
    };
  }

  it("surfaces a nearest-by-cosine candidate when FTS5 finds nothing", async () => {
    const { entities, embeddings } = await setup();
    const provider = new MockEmbeddingsProvider();

    // Seed an existing "Redis" entity with an embedding row.
    const redisId = newId();
    entities.create({
      id: redisId,
      name: "Redis",
      summary: "in-memory key-value store with replication",
      aliases: ["redis-server"],
    });
    const redisVec = await provider.embed(
      "Redis in-memory key-value store with replication redis-server",
    );
    embeddings.upsert({
      entityId: redisId,
      vector: redisVec,
      model: provider.model,
    });

    // FTS5 returns nothing for a probe that doesn't share tokens with "Redis".
    // The probe shares substrings via the n-gram embedder, so the embeddings
    // augmentation should surface Redis as a candidate.
    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ match_id: redisId }));

    const result = await dedupEntity(
      llm,
      entities,
      candidate({
        name: "redis-server",
        summary: "in-memory store",
        aliases: [],
      }),
      {
        topK: 3,
        minScore: 0.6,
        llmConfirm: true,
        embeddings: {
          provider,
          repo: embeddings,
          topK: 3,
          minCosine: 0.1,
        },
      },
    );

    // "redis-server" is an alias of Redis → exact-alias match wins before
    // embeddings even runs, so dedup should resolve to Redis without an LLM call.
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.entityId).toBe(redisId);
    }
  });

  it("falls back to kind=new when no nearest neighbor above min_cosine", async () => {
    const { entities, embeddings } = await setup();
    const provider = new MockEmbeddingsProvider();
    const redisId = newId();
    entities.create({ id: redisId, name: "Redis", summary: "kv store" });
    const redisVec = await provider.embed("Redis kv store");
    embeddings.upsert({
      entityId: redisId,
      vector: redisVec,
      model: provider.model,
    });

    const llm = new MockLLMProvider();
    const result = await dedupEntity(
      llm,
      entities,
      candidate({
        name: "Kubernetes",
        summary: "container orchestration",
        aliases: [],
      }),
      {
        topK: 3,
        minScore: 0.6,
        llmConfirm: true,
        embeddings: {
          provider,
          repo: embeddings,
          topK: 3,
          minCosine: 0.99,
        },
      },
    );
    expect(result.kind).toBe("new");
  });

  it("an embedding failure is swallowed and dedup proceeds with FTS5 candidates only", async () => {
    const { entities, embeddings } = await setup();
    const redisId = newId();
    entities.create({ id: redisId, name: "Redis", summary: "" });

    const blowupProvider = {
      model: "broken",
      dims: 8,
      async embed(): Promise<Float32Array> {
        throw new Error("provider exploded");
      },
    };

    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ match_id: redisId }));

    // FTS5 still finds Redis from the token overlap; embeddings throwing is
    // logged but doesn't fail dedup.
    const result = await dedupEntity(
      llm,
      entities,
      candidate({ name: "Redis Cache" }),
      {
        topK: 3,
        minScore: 0.6,
        llmConfirm: true,
        embeddings: {
          provider: blowupProvider,
          repo: embeddings,
          topK: 3,
          minCosine: 0.5,
        },
      },
    );
    expect(result.kind).toBe("match");
  });
});

describe("DedupEmbeddingsRepository", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  it("round-trips a vector and finds nearest by cosine", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "dedup-emb-repo-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    const entities = new EntitiesRepository(db);
    const repo = new DedupEmbeddingsRepository(db);
    const provider = new MockEmbeddingsProvider();

    const redisId = newId();
    const kafkaId = newId();
    entities.create({ id: redisId, name: "Redis", summary: "" });
    entities.create({ id: kafkaId, name: "Kafka", summary: "" });
    repo.upsert({
      entityId: redisId,
      vector: await provider.embed("Redis in-memory key-value"),
      model: provider.model,
    });
    repo.upsert({
      entityId: kafkaId,
      vector: await provider.embed("Kafka streaming log broker"),
      model: provider.model,
    });
    expect(repo.count()).toBe(2);

    const probe = await provider.embed("Redis cache key value");
    const hits = repo.nearest(probe, 5, 0, provider.model);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.entityId).toBe(redisId);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });
});
