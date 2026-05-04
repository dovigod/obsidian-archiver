import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import matter from "gray-matter";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { MockLLMProvider } from "@core/llm/mock";
import { runStage2Pipeline } from "@core/pipeline/run";
import type { ConversationLink } from "@core/repository/knowledge";
import { prepareVaultRepo, testTmpDir } from "./helpers";

describe("Stage 2 pipeline (mock LLM)", () => {
  it("two Redis conversations produce one knowledge/Redis.md integrating both, with backlinks", async () => {
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

    const llm = new MockLLMProvider();

    const r1 = await archiveConversation(config, {
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
    });

    // First ingestion: empty graph -> resolveEntity short-circuits without an
    // LLM call. So we only need (1) classify + (2) synthesize responses.
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            categories: ["Database", "Caching"],
            summary:
              "In-memory key-value store, frequently used for caching.",
          },
        ],
      }),
      "## Overview\n\nRedis is an in-memory key-value store useful for caching.\n\n## Notes\n\n- Key-value semantics.\n- Memory-resident, persistence is optional.\n",
    );

    const run1 = await runStage2Pipeline(config, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });
    assert.equal(run1.entities.length, 1);
    assert.equal(run1.entities[0]?.name, "Redis");
    assert.equal(run1.entities[0]?.matched, null);

    const r2 = await archiveConversation(config, {
      source: "claude-code",
      created_at: "2026-05-02T11:00:00.000Z",
      messages: [
        { role: "user", content: "Does Redis support replication?" },
        {
          role: "assistant",
          content: "Yes, Redis supports primary/replica replication.",
        },
      ],
    });

    // Second ingestion: graph has one entry -> classify + resolve + synthesize.
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            categories: ["Database"],
            summary: "Supports primary/replica replication.",
          },
        ],
      }),
      JSON.stringify({ match: "Redis", reason: "same entity" }),
      "## Overview\n\nRedis is an in-memory key-value store useful for caching, with primary/replica replication available.\n\n## Notes\n\n- Key-value semantics.\n- Memory-resident, persistence is optional.\n- Primary/replica replication supported.\n",
    );

    const run2 = await runStage2Pipeline(config, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });
    assert.equal(run2.entities.length, 1);
    assert.equal(run2.entities[0]?.matched, "Redis");

    // Verify the single canonical Redis.md integrates both conversations.
    const redisPath = join(vault, "knowledge", "Redis.md");
    const text = readFileSync(redisPath, "utf8");
    const parsed = matter(text);

    assert.equal(parsed.data.name, "Redis");

    const sources = parsed.data.sources as ConversationLink[];
    assert.equal(sources.length, 2, "Redis.md should list both conversations");
    const sourceIds = sources.map((s) => s.id).sort();
    assert.deepEqual(
      sourceIds,
      [r1.conversation.id, r2.conversation.id].sort(),
    );

    assert.match(parsed.content, /in-memory key-value store/);
    assert.match(parsed.content, /replication/);
    // Both source backlinks present in the body's ## Sources section.
    assert.match(parsed.content, new RegExp(r1.conversation.id));
    assert.match(parsed.content, new RegExp(r2.conversation.id));

    // Categories accumulate across runs (Database from both, Caching from r1).
    assert.deepEqual(
      [...(parsed.data.categories as string[])].sort(),
      ["Caching", "Database"],
    );
  });

  it("classify returning [] writes nothing", async () => {
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

    const r = await archiveConversation(config, {
      source: "claude-code",
      created_at: "2026-05-02T10:00:00.000Z",
      messages: [{ role: "user", content: "hello" }],
    });

    const llm = new MockLLMProvider();
    llm.enqueue(JSON.stringify({ entities: [] }));

    const result = await runStage2Pipeline(config, llm, {
      conversationId: r.conversation.id,
      conversationPath: r.relativePath,
    });
    assert.equal(result.entities.length, 0);
    assert.equal(llm.calls.length, 1, "only classify should have been called");
  });

  it("resolve returning null creates a new entity rather than merging", async () => {
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

    const llm = new MockLLMProvider();

    // First conversation creates Redis.
    const r1 = await archiveConversation(config, {
      source: "claude-code",
      created_at: "2026-05-02T10:00:00.000Z",
      messages: [
        { role: "user", content: "Tell me about Redis" },
        { role: "assistant", content: "It is a KV store." },
      ],
    });
    llm.enqueue(
      JSON.stringify({
        entities: [
          { name: "Redis", categories: ["Database"], summary: "KV store" },
        ],
      }),
      "## Overview\n\nKV store.\n",
    );
    await runStage2Pipeline(config, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });

    // Second conversation references PostgreSQL — distinct entity.
    const r2 = await archiveConversation(config, {
      source: "claude-code",
      created_at: "2026-05-02T11:00:00.000Z",
      messages: [
        { role: "user", content: "What about PostgreSQL?" },
        { role: "assistant", content: "Relational DB." },
      ],
    });
    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "PostgreSQL",
            categories: ["Database"],
            summary: "Relational DB",
          },
        ],
      }),
      JSON.stringify({ match: null, reason: "different entity" }),
      "## Overview\n\nRelational database.\n",
    );

    const run2 = await runStage2Pipeline(config, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });
    assert.equal(run2.entities[0]?.matched, null);
    assert.equal(run2.entities[0]?.name, "PostgreSQL");

    // Both files should now exist.
    assert.ok(readFileSync(join(vault, "knowledge", "Redis.md"), "utf8"));
    assert.ok(readFileSync(join(vault, "knowledge", "PostgreSQL.md"), "utf8"));
  });
});
