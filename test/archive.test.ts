import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import matter from "gray-matter";
import { simpleGit } from "simple-git";
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

    assert.match(
      result.relativePath,
      /^raw\/conversations\/2026\/05\/[0-9a-f-]+\.md$/,
    );
    const text = readFileSync(result.absolutePath, "utf8");
    const parsed = matter(text);
    assert.equal(parsed.data.source, "claude-code");
    assert.equal(parsed.data.id, result.conversation.id);
    assert.deepEqual(parsed.data.project, ["tada-wallet"]);
    assert.deepEqual(parsed.data.topics, ["redis"]); // dedup + trim
    assert.match(parsed.content, /# User\n/);
    assert.match(parsed.content, /# Assistant\n/);
    assert.equal(result.committed, false);
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

    await assert.rejects(
      archiveConversation(config, {
        source: "manual",
        messages: [],
      }),
    );
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

    assert.equal(results.length, N);
    const ids = new Set(results.map((r) => r.conversation.id));
    assert.equal(ids.size, N, "every archive should get a unique uuid v7 id");
    for (const r of results) {
      assert.equal(r.committed, true, `result ${r.conversation.id} not committed`);
    }

    const files = readdirSync(join(vault, "raw", "conversations", "2026", "05"));
    assert.equal(files.length, N);

    const log = await simpleGit({ baseDir: vault }).log();
    assert.equal(log.total, N);
  });
});

describe("autoCommit", () => {
  it("retries past a transient .git/index.lock", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "git-indexlock-retry-"));
    const vault = dir;
    await prepareVaultRepo(vault);
    // Seed the repo with one commit so HEAD exists and .git/ is bootstrapped.
    writeFileSync(join(vault, "seed.md"), "seed");
    const seeded = await autoCommit({
      vaultPath: vault,
      files: [join(vault, "seed.md")],
      message: "seed",
    });
    assert.equal(seeded, true);

    // Drop a fake lock; remove it during the retry backoff window so the
    // second or third attempt succeeds.
    const lockPath = join(vault, ".git", "index.lock");
    writeFileSync(lockPath, "");
    setTimeout(() => {
      rmSync(lockPath, { force: true });
    }, 80); // first retry sleeps 50ms → second attempt at ~50ms still locked,
    // lock cleared at 80ms, third attempt at ~200ms succeeds.

    writeFileSync(join(vault, "next.md"), "next");
    const committed = await autoCommit({
      vaultPath: vault,
      files: [join(vault, "next.md")],
      message: "after-retry",
    });
    assert.equal(committed, true);
  });
});
