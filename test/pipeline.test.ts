import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { MockLLMProvider } from "@core/llm/mock";
import { runStage2Pipeline } from "@core/pipeline/run";
import type { ConversationLink } from "@core/repository/knowledge";
import type { ClassifyDecision, Rebalancing } from "@core/schema";
import { prepareVaultRepo, testTmpDir } from "./helpers";

interface ScriptDecisionArgs {
  decision?: Partial<ClassifyDecision>;
  mode?: "auto" | "proposal";
  rebalancing?: Partial<Rebalancing>;
  warnings?: string[];
}

function classifyJson({
  decision,
  mode = "auto",
  rebalancing,
  warnings = [],
}: ScriptDecisionArgs = {}): string {
  const fullDecision: ClassifyDecision = {
    is_duplicate_of: null,
    primary_parent_id: "",
    primary_parent_name: "",
    additional_index_ids: [],
    additional_index_names: [],
    new_category_proposal: null,
    aliases: [],
    secondary_relations: [],
    confidence: 0.9,
    ...(decision ?? {}),
  };
  const fullRebalancing: Rebalancing = {
    needed: false,
    reasons: [],
    actions: [],
    ...(rebalancing ?? {}),
  };
  return JSON.stringify({
    decision: fullDecision,
    mode,
    reasoning: {
      semantic_fit: "",
      sibling_analysis: "",
      rejected_candidates: [],
      ontology_considerations: "",
    },
    rebalancing: fullRebalancing,
    warnings,
  });
}

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

    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            summary: "In-memory key-value store, frequently used for caching.",
            tags: ["storage", "in-memory"],
            aliases: ["redis-server"],
          },
        ],
      }),
      classifyJson({
        decision: {
          primary_parent_id: "cat_kv",
          primary_parent_name: "Key-Value Store",
          additional_index_ids: ["cat_caching"],
          additional_index_names: ["Caching"],
          aliases: ["redis-server", "Redis"],
          confidence: 0.91,
        },
      }),
      "## Overview\n\nRedis is an in-memory key-value store useful for caching.\n\n## Notes\n\n- Key-value semantics.\n- Memory-resident, persistence is optional.\n",
    );

    const run1 = await runStage2Pipeline(config, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });
    expect(run1.entities.length).toBe(1);
    expect(run1.entities[0]?.name).toBe("Redis");
    expect(run1.entities[0]?.applied).toBe(true);
    expect(run1.entities[0]?.matched).toBeNull();

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

    llm.enqueue(
      JSON.stringify({
        entities: [
          {
            name: "Redis",
            summary: "Supports primary/replica replication.",
            tags: ["replication"],
            aliases: [],
          },
        ],
      }),
      classifyJson({
        decision: {
          is_duplicate_of: "Redis",
          primary_parent_id: "cat_kv",
          primary_parent_name: "Key-Value Store",
          aliases: [],
          confidence: 0.95,
        },
      }),
      "## Overview\n\nRedis is an in-memory key-value store useful for caching, with primary/replica replication available.\n\n## Notes\n\n- Key-value semantics.\n- Memory-resident, persistence is optional.\n- Primary/replica replication supported.\n",
    );

    const run2 = await runStage2Pipeline(config, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });
    expect(run2.entities.length).toBe(1);
    expect(run2.entities[0]?.matched).toBe("Redis");
    expect(run2.entities[0]?.applied).toBe(true);

    const redisPath = join(vault, "knowledge", "Redis.md");
    const text = readFileSync(redisPath, "utf8");
    const parsed = matter(text);

    expect(parsed.data.name).toBe("Redis");

    const sources = parsed.data.sources as ConversationLink[];
    expect(sources.length).toBe(2);
    const sourceIds = sources.map((s) => s.id).sort();
    expect(sourceIds).toEqual(
      [r1.conversation.id, r2.conversation.id].sort(),
    );

    expect(parsed.content).toMatch(/in-memory key-value store/);
    expect(parsed.content).toMatch(/replication/);
    expect(parsed.content).toMatch(new RegExp(r1.conversation.id));
    expect(parsed.content).toMatch(new RegExp(r2.conversation.id));

    expect([...(parsed.data.categories as string[])].sort()).toEqual([
      "Caching",
      "Key-Value Store",
    ]);

    const aliases = parsed.data.aliases as string[];
    expect(aliases).toContain("redis-server");

    expect(parsed.data.primary_parent_id).toBe("cat_kv");
    expect(parsed.data.additional_index_ids).toEqual(["cat_caching"]);
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
    expect(result.entities.length).toBe(0);
    expect(llm.calls.length).toBe(1);
  });

  it("is_duplicate_of=null with distinct entity creates a separate page", async () => {
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
          { name: "Redis", summary: "KV store", tags: [], aliases: [] },
        ],
      }),
      classifyJson({
        decision: {
          primary_parent_id: "cat_kv",
          primary_parent_name: "Key-Value Store",
          confidence: 0.9,
        },
      }),
      "## Overview\n\nKV store.\n",
    );
    await runStage2Pipeline(config, llm, {
      conversationId: r1.conversation.id,
      conversationPath: r1.relativePath,
    });

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
            summary: "Relational DB",
            tags: [],
            aliases: [],
          },
        ],
      }),
      classifyJson({
        decision: {
          is_duplicate_of: null,
          primary_parent_id: "cat_relational",
          primary_parent_name: "Relational Database",
          confidence: 0.88,
        },
      }),
      "## Overview\n\nRelational database.\n",
    );

    const run2 = await runStage2Pipeline(config, llm, {
      conversationId: r2.conversation.id,
      conversationPath: r2.relativePath,
    });
    expect(run2.entities[0]?.matched).toBeNull();
    expect(run2.entities[0]?.name).toBe("PostgreSQL");

    expect(readFileSync(join(vault, "knowledge", "Redis.md"), "utf8")).toBeTruthy();
    expect(
      readFileSync(join(vault, "knowledge", "PostgreSQL.md"), "utf8"),
    ).toBeTruthy();
  });

  it("mode=proposal stages a classification proposal and skips entity write", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-proposal-"));
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
      messages: [
        { role: "user", content: "What is Neo4j?" },
        { role: "assistant", content: "A graph database." },
      ],
    });

    const llm = new MockLLMProvider();
    llm.enqueue(
      JSON.stringify({
        entities: [
          { name: "Neo4j", summary: "Graph database.", tags: [], aliases: [] },
        ],
      }),
      classifyJson({
        decision: {
          primary_parent_id: "cat_db",
          primary_parent_name: "Database",
          new_category_proposal: {
            name: "Graph Database",
            parent_id: "cat_db",
            summary: "Graph-shaped storage.",
            rationale: "Database is overloaded; split out graph stores.",
          },
          confidence: 0.6,
        },
        mode: "proposal",
        rebalancing: {
          needed: true,
          reasons: ["Database mixes multiple storage models."],
          actions: [
            {
              type: "split",
              target_id: "cat_db",
              details:
                "Split Database into Relational, Document, Key-Value, Graph.",
            },
          ],
        },
      }),
    );

    const result = await runStage2Pipeline(config, llm, {
      conversationId: r.conversation.id,
      conversationPath: r.relativePath,
    });

    expect(result.entities.length).toBe(1);
    expect(result.entities[0]?.applied).toBe(false);
    expect(result.entities[0]?.written).toBeNull();
    expect(existsSync(join(vault, "knowledge", "Neo4j.md"))).toBe(false);

    const kinds = result.entities[0]?.proposals.map((p) => p.kind).sort() ?? [];
    expect(kinds).toEqual(["classification", "new_category", "rebalancing"]);

    const proposalsDir = join(vault, "_proposals");
    expect(existsSync(proposalsDir)).toBe(true);
    const newCatFiles = await readdir(join(proposalsDir, "new_category"));
    expect(newCatFiles.length).toBe(1);
    const rebalanceFiles = await readdir(join(proposalsDir, "rebalancing"));
    expect(rebalanceFiles.length).toBe(1);
    const classifyFiles = await readdir(join(proposalsDir, "classification"));
    expect(classifyFiles.length).toBe(1);

    expect(llm.calls.length).toBe(2);
  });

  it("classify schema-validation failure retries once, then falls back to mode=proposal", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "stage2-fallback-"));
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
      messages: [
        { role: "user", content: "Tell me about Kafka." },
        { role: "assistant", content: "Distributed log." },
      ],
    });

    const llm = new MockLLMProvider();
    llm.enqueue(
      JSON.stringify({
        entities: [
          { name: "Kafka", summary: "Distributed log", tags: [], aliases: [] },
        ],
      }),
      "I don't know how to fill out that JSON.",
      "Still no JSON, sorry.",
    );

    const result = await runStage2Pipeline(config, llm, {
      conversationId: r.conversation.id,
      conversationPath: r.relativePath,
    });

    expect(result.entities.length).toBe(1);
    expect(result.entities[0]?.applied).toBe(false);
    expect(existsSync(join(vault, "knowledge", "Kafka.md"))).toBe(false);

    const kinds = result.entities[0]?.proposals.map((p) => p.kind).sort() ?? [];
    expect(kinds).toContain("raw_invalid");
    expect(kinds).toContain("classification");

    const rawInvalidFiles = await readdir(
      join(vault, "_proposals", "raw_invalid"),
    );
    expect(rawInvalidFiles.length).toBe(1);
    const rawText = await readFile(
      join(vault, "_proposals", "raw_invalid", rawInvalidFiles[0]!),
      "utf8",
    );
    const rawRecord = JSON.parse(rawText);
    expect(rawRecord.kind).toBe("raw_invalid");
    expect(rawRecord.payload.raw_text).toMatch(/Still no JSON/);

    expect(llm.calls.length).toBe(3);
  });
});
