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
    expect(result.notesJobId).toBeTruthy();

    // SQLite row + jobs all materialized
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

    const notesJob = sqlite
      .prepare(`SELECT type, state FROM jobs WHERE id = ?`)
      .get(result.notesJobId) as { type: string; state: string };
    expect(notesJob.type).toBe("notes");
    expect(notesJob.state).toBe("pending");
  });

  it("still parses legacy Template A files back into Conversation fields", async () => {
    // Template A is no longer written (notes replaced it), but archives that
    // already exist on disk must keep round-tripping.
    const dir = mkdtempSync(join(testTmpDir(), "archive-template-a-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const rel = join("raw", "conversations", "2026", "06", "legacy-a.md");
    const legacy = [
      "---",
      "id: legacy-a",
      "source: claude-code",
      'created_at: "2026-06-03T14:00:00.000Z"',
      "intent: sync to kh",
      "---",
      "## TL;DR",
      "",
      "User asked for archive templates; picked summary-first verbatim.",
      "",
      "## Key takeaways",
      "",
      "- Capture is intent-driven by default",
      "",
      "## Entities",
      "",
      "- [[Knowledge Hub]]",
      "",
      "## Conversation",
      "",
      "# User",
      "",
      "suggest templates",
      "",
      "# Assistant",
      "",
      "here are four options",
      "",
      "## Related questions",
      "",
      "- What does intent-driven capture mean in plain words?",
      "",
    ].join("\n");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(vault, "raw", "conversations", "2026", "06"), {
      recursive: true,
    });
    writeFileSync(join(vault, rel), legacy);

    const { MarkdownVaultRepository } = await import("@core/repository/raw");
    const repo = new MarkdownVaultRepository(vault);
    const conv = await repo.readConversation(rel);
    expect(conv.intent).toBe("sync to kh");
    expect(conv.summary).toBe(
      "User asked for archive templates; picked summary-first verbatim.",
    );
    expect(conv.takeaways).toEqual(["Capture is intent-driven by default"]);
    expect(conv.entities).toEqual(["Knowledge Hub"]);
    expect(conv.related_questions).toEqual([
      "What does intent-driven capture mean in plain words?",
    ]);
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.messages[0]!.content).toBe("suggest templates");
    // The trailing `## Related questions` section must NOT bleed into the last
    // assistant message — parseMessagesBody clips at the next ^## H2.
    expect(conv.messages[1]!.content).toBe("here are four options");
    expect(conv.messages[1]!.content).not.toMatch(/Related questions/);
  });

  it("round-trips assistant content containing markdown headings losslessly", async () => {
    // Regression: the legacy `# Role` divider format swallowed everything
    // after a column-0 `#` heading inside message content (e.g. an assistant
    // answer that starts with "# CMake 설명"), so topic notes were built from
    // empty assistant bodies. Sentinel dividers fix this.
    const dir = mkdtempSync(join(testTmpDir(), "archive-headings-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: { vault: { path: vault }, git: { auto_commit: false } },
    });
    const { db, sqlite } = setup(vault);

    const answer = [
      "# CMake 설명",
      "",
      "CMake는 빌드 시스템 생성기입니다.",
      "",
      "## 왜 필요한가",
      "",
      "```bash",
      "g++ -std=c++20 main.cpp -o app",
      "```",
      "",
      "## 동작 흐름",
      "",
      "| 단계 | 도구 |",
      "|---|---|",
      "| configure | cmake |",
    ].join("\n");

    const result = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-06-03T15:00:00.000Z",
        messages: [
          {
            role: "user",
            content: "c++ cmake에 대해 설명해줘",
            timestamp: "2026-06-03T15:00:00.000Z",
          },
          { role: "assistant", content: answer },
        ],
      },
    );

    const { MarkdownVaultRepository } = await import("@core/repository/raw");
    const repo = new MarkdownVaultRepository(vault);
    const conv = await repo.readConversation(result.relativePath);
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0]).toMatchObject({
      role: "user",
      content: "c++ cmake에 대해 설명해줘",
      timestamp: "2026-06-03T15:00:00.000Z",
    });
    // The full assistant answer survives — headings, code fence, table.
    expect(conv.messages[1]!.role).toBe("assistant");
    expect(conv.messages[1]!.content).toBe(answer);
  });

  it("falls back to verbatim-only body when template fields are omitted", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-template-omit-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: { vault: { path: vault }, git: { auto_commit: false } },
    });
    const { db, sqlite } = setup(vault);

    const result = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-06-03T14:00:00.000Z",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
    );
    const text = readFileSync(result.absolutePath, "utf8");
    expect(text).not.toMatch(/## TL;DR/);
    expect(text).not.toMatch(/## Conversation/);
    expect(text).toMatch(/# User\n/);
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

  it("commit message describes what was archived (questions, not just ids)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-commitmsg-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: { vault: { path: vault }, git: { auto_commit: true } },
    });
    const { db, sqlite } = setup(vault);

    const result = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-06-03T16:00:00.000Z",
        intent: "이 내용들 다 아카이브해줘",
        messages: [
          { role: "user", content: "c++ cmake에 대해 설명해줘" },
          { role: "assistant", content: "CMake는 빌드 시스템 생성기입니다." },
          { role: "user", content: "어떻게 동작해?" },
          { role: "assistant", content: "Configure → Generate → Build 3단계입니다." },
        ],
      },
    );
    expect(result.committed).toBe(true);

    const log = await simpleGit({ baseDir: vault }).log();
    // Subject leads with the first user question, not an opaque id.
    expect(log.latest!.message).toBe(
      "archive(raw): c++ cmake에 대해 설명해줘",
    );
    expect(log.latest!.body).toContain("source: claude-code");
    expect(log.latest!.body).toContain("intent: 이 내용들 다 아카이브해줘");
    expect(log.latest!.body).toContain("- c++ cmake에 대해 설명해줘");
    expect(log.latest!.body).toContain("- 어떻게 동작해?");
    expect(log.latest!.body).toContain(
      `conversation: ${result.conversation.id}`,
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
