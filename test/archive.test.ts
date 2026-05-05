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
import { describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { autoCommit } from "@core/git";
import { SequentialQueue } from "@core/queue/sequential-queue";
import type { ArchiveInput } from "@core/schema";
import { prepareVaultRepo, testTmpDir } from "./helpers";

describe("archiveConversation (Stage 1)", () => {
  it("writes a markdown file with valid frontmatter", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-write-"));
    const vault = join(dir, "vault");
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });

    const result = await archiveConversation(config, {
      source: "claude-code",
      created_at: "2026-05-02T14:22:00.000Z",
      project: ["tada-wallet"],
      topics: ["redis", "redis", "  "],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    expect(result.relativePath).toMatch(
      /^raw\/conversations\/2026\/05\/[0-9a-f-]+\.md$/,
    );
    const text = readFileSync(result.absolutePath, "utf8");
    const parsed = matter(text);
    expect(parsed.data.source).toBe("claude-code");
    expect(parsed.data.id).toBe(result.conversation.id);
    expect(parsed.data.project).toEqual(["tada-wallet"]);
    expect(parsed.data.topics).toEqual(["redis"]); // dedup + trim
    expect(parsed.content).toMatch(/# User\n/);
    expect(parsed.content).toMatch(/# Assistant\n/);
    expect(result.committed).toBe(false);
  });

  it("rejects empty message arrays via schema", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-reject-empty-msgs-"));
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: join(dir, "vault") },
        git: { auto_commit: false },
      },
    });

    await expect(
      archiveConversation(config, {
        source: "manual",
        messages: [],
      }),
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
        queue.enqueue(() => archiveConversation(config, input)),
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
