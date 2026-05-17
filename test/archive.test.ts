import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { autoCommit } from "@core/git";
import { SequentialQueue } from "@core/queue/sequential-queue";
import type { ArchiveInput } from "@core/schema";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("archiveConversation (Stage 1)", () => {
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

  it("writes a markdown file, inserts conversations row, and enqueues extract job", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-write-"));
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

    const result = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T14:22:00.000Z",
        project: ["tada-wallet"],
        topics: ["redis", "redis", "  "],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
      },
    );

    expect(result.relativePath).toMatch(
      /^raw\/conversations\/2026\/05\/[0-9a-f-]+\.md$/,
    );
    const text = readFileSync(result.absolutePath, "utf8");
    const parsed = matter(text);
    expect(parsed.data.source).toBe("claude-code");
    expect(parsed.data.id).toBe(result.conversation.id);
    expect(parsed.data.project).toEqual(["tada-wallet"]);
    expect(parsed.data.topics).toEqual(["redis"]);
    expect(parsed.content).toMatch(/# User\n/);
    expect(parsed.content).toMatch(/# Assistant\n/);
    expect(result.committed).toBe(false);
    expect(result.extractJobId).toBeTruthy();

    // SQLite row + job both materialized
    const row = sqlite
      .prepare(`SELECT id, raw_path FROM conversations WHERE id = ?`)
      .get(result.conversation.id) as { id: string; raw_path: string };
    expect(row.id).toBe(result.conversation.id);
    expect(row.raw_path).toBe(result.relativePath);

    const job = sqlite
      .prepare(`SELECT type, state FROM jobs WHERE id = ?`)
      .get(result.extractJobId) as { type: string; state: string };
    expect(job.type).toBe("extract");
    expect(job.state).toBe("pending");
  });

  it("rejects empty message arrays via schema", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-reject-empty-msgs-"));
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

    await expect(
      archiveConversation(
        { config, db, sqlite },
        {
          source: "manual",
          messages: [],
        },
      ),
    ).rejects.toThrow();
  });

  it("serializes concurrent archives via SequentialQueue (10 calls, 10 commits)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-concurrent-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: true },
      },
    });
    const { db, sqlite } = setup(vault);

    const queue = new SequentialQueue();
    const N = 10;
    const inputs: ArchiveInput[] = Array.from({ length: N }, (_, i) => ({
      source: "claude-code",
      created_at: "2026-05-02T14:22:00.000Z",
      messages: [
        { role: "user", content: `q${i}` },
        { role: "assistant", content: `a${i}` },
      ],
    }));

    const results = await Promise.all(
      inputs.map((input) =>
        queue.enqueue(() => archiveConversation({ config, db, sqlite }, input)),
      ),
    );

    expect(results.length).toBe(N);
    const ids = new Set(results.map((r) => r.conversation.id));
    expect(ids.size).toBe(N);
    for (const r of results) {
      expect(r.committed).toBe(true);
    }

    const files = readdirSync(join(vault, "raw", "conversations", "2026", "05"));
    expect(files.length).toBe(N);

    const log = await simpleGit({ baseDir: vault }).log();
    expect(log.total).toBe(N);
  });
});

describe("autoCommit", () => {
  beforeEach(() => {
    /* no-op */
  });

  it("retries past a transient .git/index.lock", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "git-indexlock-retry-"));
    const vault = dir;
    await prepareVaultRepo(vault);
    writeFileSync(join(vault, "seed.md"), "seed");
    const seeded = await autoCommit({
      vaultPath: vault,
      files: [join(vault, "seed.md")],
      message: "seed",
    });
    expect(seeded).toBe(true);

    const lockPath = join(vault, ".git", "index.lock");
    writeFileSync(lockPath, "");
    setTimeout(() => {
      rmSync(lockPath, { force: true });
    }, 80);

    writeFileSync(join(vault, "next.md"), "next");
    const committed = await autoCommit({
      vaultPath: vault,
      files: [join(vault, "next.md")],
      message: "after-retry",
    });
    expect(committed).toBe(true);
  });
});
