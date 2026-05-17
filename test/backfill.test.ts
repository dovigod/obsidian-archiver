import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@core/config";
import type { SqliteHandle } from "@core/db/client";
import { ConversationsRepository } from "@core/db/repository/conversations";
import { backfill } from "@core/pipeline/backfill";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("backfill", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup() {
    const dir = mkdtempSync(join(testTmpDir(), "backfill-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    return { dir, vault, config, db, sqlite };
  }

  it("imports mixed-source transcripts and is idempotent on re-run", async () => {
    const { dir, config, db, sqlite } = await setup();

    // Drop one Claude Code .jsonl + one ChatGPT conversations.json into a
    // backfill source directory.
    const src = join(dir, "transcripts");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-05-02T14:22:00.000Z",
          message: { role: "user", content: "hi from claude code" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-05-02T14:22:30.000Z",
          message: { role: "assistant", content: "hello back" },
        }),
      ].join("\n"),
    );
    writeFileSync(
      join(src, "conversations.json"),
      JSON.stringify([
        {
          title: "ChatGPT thread",
          create_time: 1_700_000_000,
          current_node: "leaf",
          mapping: {
            root: { id: "root", parent: null, message: null },
            n1: {
              id: "n1",
              parent: "root",
              message: {
                author: { role: "user" },
                create_time: 1_700_000_001,
                content: { content_type: "text", parts: ["hi from gpt"] },
              },
            },
            leaf: {
              id: "leaf",
              parent: "n1",
              message: {
                author: { role: "assistant" },
                create_time: 1_700_000_002,
                content: { content_type: "text", parts: ["hello back gpt"] },
              },
            },
          },
        },
      ]),
    );

    const first = await backfill({ config, db, sqlite }, src);
    expect(first.scanned).toBe(2);
    expect(first.imported).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.errors.length).toBe(0);

    const conversationsRepo = new ConversationsRepository(db);
    expect(conversationsRepo.count()).toBe(2);

    // Re-run — content_hash idempotency should skip both.
    const second = await backfill({ config, db, sqlite }, src);
    expect(second.scanned).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(conversationsRepo.count()).toBe(2);
  });

  it("dry-run reports scanned without writing", async () => {
    const { dir, config, db, sqlite } = await setup();
    const src = join(dir, "transcripts");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "session.jsonl"),
      JSON.stringify({ role: "user", content: "hi" }),
    );

    const result = await backfill({ config, db, sqlite }, src, {
      dryRun: true,
    });
    expect(result.scanned).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    const conversationsRepo = new ConversationsRepository(db);
    expect(conversationsRepo.count()).toBe(0);
  });

  it("reports an error and returns when dir does not exist", async () => {
    const { config, db, sqlite } = await setup();
    const result = await backfill(
      { config, db, sqlite },
      join(testTmpDir(), "does-not-exist"),
    );
    expect(result.scanned).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});
