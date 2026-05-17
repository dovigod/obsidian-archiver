import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { EntitiesRepository } from "@core/db/repository/entities";
import { MockLLMProvider } from "@core/llm/mock";
import { runStage2Pipeline } from "@core/pipeline/run";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("Stage 2 pipeline (mock LLM)", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  function setup(vault: string): { db: DB; sqlite: SqliteHandle } {
    const opened = openTestDb(vault);
    openHandle = opened.sqlite;
    return opened;
  }

  it("two Redis conversations produce one entity row and one rendered Redis.md integrating both", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-redis-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = setup(vault);
    const llm = new MockLLMProvider();

    const r1 = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [
          { role: "user", content: "What is Redis good for?" },
          {
            role: "assistant",
            content:
              "Redis is an in-memory key-value store, great for caching.",
          },
        ],
      },
    );

    llm.enqueue(
      // Extract response
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            summary: "In-memory key-value store.",
            tags: ["storage", "in-memory"],
            aliases: ["redis-server"],
            draft_body:
              "## Overview\n\nRedis is an in-memory key-value store used for caching.\n",
          },
        ],
      }),
    );

    const run1 = await runStage2Pipeline(config, db, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });

    expect(run1.entities.length).toBe(1);
    expect(run1.entities[0]?.entityName).toBe("Redis");
    expect(run1.entities[0]?.created).toBe(true);
    expect(run1.rendered.written).toContain(join("knowledge", "Redis.md"));

    // Second conversation — extract returns Redis again; exact-name dedup hits.
    // No dedup LLM call needed (exact match short-circuits the prompt). The
    // rewrite LLM call then integrates the new content.
    const r2 = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T11:00:00.000Z",
        messages: [
          { role: "user", content: "Does Redis support replication?" },
          {
            role: "assistant",
            content: "Yes, Redis supports primary/replica replication.",
          },
        ],
      },
    );

    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            summary: "Supports primary/replica replication.",
            tags: ["replication"],
            aliases: [],
            draft_body: "",
          },
        ],
      }),
      // Rewrite response (LLM integrates new excerpt into existing body)
      "## Overview\n\nRedis is an in-memory key-value store useful for caching, with primary/replica replication available.\n\n## Notes\n\n- Key-value semantics.\n- Memory-resident, persistence optional.\n- Primary/replica replication supported.\n",
    );

    const run2 = await runStage2Pipeline(config, db, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });

    expect(run2.entities.length).toBe(1);
    expect(run2.entities[0]?.created).toBe(false);
    expect(run2.entities[0]?.matched).toBe("Redis");

    // Single canonical entity row, integrating both conversations.
    const entitiesRepo = new EntitiesRepository(db);
    const allRows = entitiesRepo.listAll();
    expect(allRows.length).toBe(1);
    const redis = entitiesRepo.findByName("Redis")!;
    expect(redis.bodyMd).toMatch(/replication/i);
    expect(redis.bodyMd).toMatch(/key-value store/i);

    // Sources link to both conversations.
    const sourceIds = entitiesRepo.listConversationIdsForEntity(redis.id).sort();
    expect(sourceIds).toEqual([r1.conversation.id, r2.conversation.id].sort());

    // Rendered file present + reflects integrated body
    const redisPath = join(vault, "knowledge", "Redis.md");
    const text = readFileSync(redisPath, "utf8");
    const parsed = matter(text);
    expect(parsed.data.name).toBe("Redis");
    expect(parsed.content).toMatch(/replication/);
    expect(parsed.content).toMatch(/in-memory key-value store/);
    expect(parsed.content).toMatch(new RegExp(r1.conversation.id));
    expect(parsed.content).toMatch(new RegExp(r2.conversation.id));
  });

  it("extract returning [] writes nothing", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-empty-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = setup(vault);

    const r = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [{ role: "user", content: "hello" }],
      },
    );

    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ entities: [] }));

    const result = await runStage2Pipeline(config, db, llm, {
      conversationId: r.conversation.id,
      conversationPath: r.relativePath,
    });
    expect(result.entities.length).toBe(0);
    expect(result.rendered.written.length).toBe(0);
    expect(llm.calls.length).toBe(1);
  });

  it("distinct entity creates a separate page", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-newent-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = setup(vault);
    const llm = new MockLLMProvider();

    const r1 = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [
          { role: "user", content: "Tell me about Redis" },
          { role: "assistant", content: "It is a KV store." },
        ],
      },
    );
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            summary: "KV store",
            tags: [],
            aliases: [],
            draft_body: "## Overview\n\nKV store.\n",
          },
        ],
      }),
    );
    await runStage2Pipeline(config, db, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });

    const r2 = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T11:00:00.000Z",
        messages: [
          { role: "user", content: "What about PostgreSQL?" },
          { role: "assistant", content: "Relational DB." },
        ],
      },
    );
    // PostgreSQL is distinct from Redis; FTS5 has Redis indexed but
    // bm25(query=postgresql) will likely return Redis with a score above
    // our cutoff (the FTS prefilter is broad). The dedup-confirm prompt
    // returns null → new entity created.
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "PostgreSQL",
            summary: "Relational DB",
            tags: [],
            aliases: [],
            draft_body: "## Overview\n\nRelational database.\n",
          },
        ],
      }),
      // Optional dedup-confirm response — only consumed if fuzzy hit fires.
      JSON.stringify({ match_id: null }),
    );

    const run2 = await runStage2Pipeline(config, db, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });
    expect(run2.entities[0]?.matched).toBeNull();
    expect(run2.entities[0]?.created).toBe(true);
    expect(run2.entities[0]?.entityName).toBe("PostgreSQL");

    expect(existsSync(join(vault, "knowledge", "Redis.md"))).toBe(true);
    expect(existsSync(join(vault, "knowledge", "PostgreSQL.md"))).toBe(true);
  });

  it("alias-exact match merges into existing entity", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-alias-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = setup(vault);
    const llm = new MockLLMProvider();

    const r1 = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [
          { role: "user", content: "tell me about PostgreSQL" },
          { role: "assistant", content: "An open-source RDBMS." },
        ],
      },
    );
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "PostgreSQL",
            summary: "Open-source RDBMS.",
            tags: [],
            aliases: ["postgres", "psql"],
            draft_body: "## Overview\n\nAn open-source relational database.\n",
          },
        ],
      }),
    );
    await runStage2Pipeline(config, db, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });

    // Second extract returns the alias as the entity name; alias-exact dedup
    // should resolve it back to the canonical PostgreSQL entity. No dedup LLM
    // call needed; rewrite LLM is invoked to integrate the new excerpt.
    const r2 = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T11:00:00.000Z",
        messages: [
          { role: "user", content: "does psql support JSONB?" },
          { role: "assistant", content: "Yes, native JSONB column type." },
        ],
      },
    );
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "psql",
            summary: "Has JSONB columns.",
            tags: [],
            aliases: [],
            draft_body: "",
          },
        ],
      }),
      // Rewrite response
      "## Overview\n\nAn open-source relational database with first-class JSONB support.\n",
    );

    const run2 = await runStage2Pipeline(config, db, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });
    expect(run2.entities[0]?.created).toBe(false);
    expect(run2.entities[0]?.entityName).toBe("PostgreSQL");

    const entitiesRepo = new EntitiesRepository(db);
    expect(entitiesRepo.listAll().length).toBe(1);
  });

  it("schema-validation failure on extract returns no entities", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-bad-extract-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = setup(vault);
    const llm = new MockLLMProvider();

    const r = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [
          { role: "user", content: "Tell me about Kafka." },
          { role: "assistant", content: "Distributed log." },
        ],
      },
    );

    llm.enqueue("not even JSON");

    const result = await runStage2Pipeline(config, db, llm, {
      conversationId: r.conversation.id,
      conversationPath: r.relativePath,
    });

    expect(result.entities.length).toBe(0);
    expect(existsSync(join(vault, "knowledge", "Kafka.md"))).toBe(false);
  });
});
