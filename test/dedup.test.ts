import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteHandle } from "@core/db/client";
import { EntitiesRepository } from "@core/db/repository/entities";
import { MockLLMProvider } from "@core/llm/mock";
import { newId } from "@core/ids";
import { dedupEntity } from "@core/pipeline/dedup";
import type { ExtractedEntity } from "@core/schema";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

const OPTS = { topK: 3, minScore: 0.6, llmConfirm: true };

function newCandidate(over: Partial<ExtractedEntity> = {}): ExtractedEntity {
  return {
    name: "Redis",
    summary: "",
    tags: [],
    aliases: [],
    draft_body: "",
    ...over,
  };
}

describe("dedupEntity", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function fresh() {
    const dir = mkdtempSync(join(testTmpDir(), "dedup-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    return new EntitiesRepository(db);
  }

  it("returns kind=new when the store is empty", async () => {
    const repo = await fresh();
    const llm = new MockLLMProvider();
    const result = await dedupEntity(llm, repo, newCandidate(), OPTS);
    expect(result.kind).toBe("new");
    expect(llm.calls.length).toBe(0);
  });

  it("exact-name match short-circuits without an LLM call", async () => {
    const repo = await fresh();
    const id = newId();
    repo.create({ id, name: "Redis", summary: "" });
    const llm = new MockLLMProvider();
    const result = await dedupEntity(llm, repo, newCandidate(), OPTS);
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.entityId).toBe(id);
    }
    expect(llm.calls.length).toBe(0);
  });

  it("exact-alias match (alias listed on existing entity) short-circuits", async () => {
    const repo = await fresh();
    const id = newId();
    repo.create({
      id,
      name: "PostgreSQL",
      summary: "",
      aliases: ["postgres", "psql"],
    });
    const llm = new MockLLMProvider();
    const result = await dedupEntity(
      llm,
      repo,
      newCandidate({ name: "psql" }),
      OPTS,
    );
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.entityId).toBe(id);
      expect(result.matchedTerm).toBe("psql");
    }
    expect(llm.calls.length).toBe(0);
  });

  it("exact match against candidate's own listed aliases also wins", async () => {
    const repo = await fresh();
    const id = newId();
    // Existing canonical entity is "PostgreSQL"; an extracted candidate
    // arrives named "psql" with aliases [...] — handled by the alias probe
    // even when the candidate's own aliases don't include the canonical name.
    repo.create({ id, name: "PostgreSQL", summary: "" });
    repo.addAliases(id, ["pg"]);
    const llm = new MockLLMProvider();
    const result = await dedupEntity(
      llm,
      repo,
      newCandidate({ name: "FooDB", aliases: ["pg"] }),
      OPTS,
    );
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.entityId).toBe(id);
    }
  });

  it("LLM-confirm=true with match_id null → kind=new", async () => {
    const repo = await fresh();
    // Seed a Redis entity so FTS5 returns something when we ask about "Kafka".
    repo.create({ id: newId(), name: "Redis", summary: "" });
    repo.create({ id: newId(), name: "Postgres", summary: "" });
    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ match_id: null }));

    const result = await dedupEntity(
      llm,
      repo,
      newCandidate({ name: "Kafka" }),
      OPTS,
    );
    expect(result.kind).toBe("new");
    // FTS5 produces no candidates for "Kafka" against {Redis,Postgres} —
    // the LLM is only consulted when there's at least one fuzzy hit, so
    // call count is 0 here. (Token tokenizer doesn't see overlap.)
    expect(llm.calls.length).toBe(0);
  });

  it("LLM-confirm=true with match_id pointing at a candidate → kind=match", async () => {
    const repo = await fresh();
    const redisId = newId();
    repo.create({ id: redisId, name: "Redis", summary: "" });

    // "Redis Cache" should hit Redis via FTS5 (shared token "Redis"). The
    // LLM-confirm step then ratifies the match.
    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ match_id: redisId }));

    const result = await dedupEntity(
      llm,
      repo,
      newCandidate({ name: "Redis Cache" }),
      OPTS,
    );
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.entityId).toBe(redisId);
    }
    expect(llm.calls.length).toBe(1);
  });

  it("llm_confirm=false accepts the top fuzzy hit without an LLM call", async () => {
    const repo = await fresh();
    const redisId = newId();
    repo.create({ id: redisId, name: "Redis", summary: "" });

    const llm = new MockLLMProvider();
    const result = await dedupEntity(
      llm,
      repo,
      newCandidate({ name: "Redis Cache" }),
      { ...OPTS, llmConfirm: false },
    );
    expect(result.kind).toBe("match");
    if (result.kind === "match") {
      expect(result.entityId).toBe(redisId);
    }
    expect(llm.calls.length).toBe(0);
  });

  it("soft-deleted entities are not considered for matching", async () => {
    const repo = await fresh();
    const id = newId();
    repo.create({ id, name: "Redis", summary: "" });
    repo.softDelete(id);
    const llm = new MockLLMProvider();
    const result = await dedupEntity(llm, repo, newCandidate(), OPTS);
    expect(result.kind).toBe("new");
  });

  it("LLM returning a hallucinated id (not in candidates) falls back to kind=new", async () => {
    const repo = await fresh();
    repo.create({ id: newId(), name: "Redis", summary: "" });
    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ match_id: "totally-made-up-id" }));
    const result = await dedupEntity(
      llm,
      repo,
      newCandidate({ name: "Redis Cache" }),
      OPTS,
    );
    expect(result.kind).toBe("new");
  });
});
