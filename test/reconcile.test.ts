import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { SqliteHandle } from "@core/db/client";
import { ConversationsRepository } from "@core/db/repository/conversations";
import { JobsRepository } from "@core/db/repository/jobs";
import { reconcile } from "@core/pipeline/reconcile";
import { newId } from "@core/ids";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("reconcile", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function fresh() {
    const dir = mkdtempSync(join(testTmpDir(), "reconcile-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    return { vault, db, sqlite };
  }

  it("noop on empty vault", async () => {
    const { vault, db, sqlite } = await fresh();
    const conversations = new ConversationsRepository(db);
    const jobs = new JobsRepository(db, sqlite);
    const result = await reconcile(vault, conversations, jobs);
    expect(result.scanned).toBe(0);
    expect(result.reinserted).toBe(0);
    expect(result.reenqueued).toBe(0);
  });

  it("skips conversations already in the DB", async () => {
    const { vault, db, sqlite } = await fresh();
    const config = loadConfig({
      skipGlobal: true,
      overrides: { vault: { path: vault }, git: { auto_commit: false } },
    });

    // Archive one — both row + raw md exist.
    await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [{ role: "user", content: "x" }],
      },
    );

    const conversations = new ConversationsRepository(db);
    const jobs = new JobsRepository(db, sqlite);
    const before = jobs.countByState("pending");
    const result = await reconcile(vault, conversations, jobs);
    expect(result.scanned).toBe(1);
    expect(result.reinserted).toBe(0);
    expect(result.reenqueued).toBe(0);
    expect(jobs.countByState("pending")).toBe(before);
  });

  it("rebuilds a conversations row from an orphan raw md and enqueues an extract job", async () => {
    const { vault, db, sqlite } = await fresh();

    // Hand-write a raw conversation with NO corresponding DB row.
    const id = newId();
    const rawDir = join(vault, "raw", "conversations", "2026", "05");
    mkdirSync(rawDir, { recursive: true });
    const body = "# User\n\nhello\n\n# Assistant\n\nworld";
    const text = matter.stringify(body, {
      id,
      source: "claude-code",
      created_at: "2026-05-02T10:00:00.000Z",
    });
    writeFileSync(join(rawDir, `${id}.md`), text, "utf8");

    const conversations = new ConversationsRepository(db);
    const jobs = new JobsRepository(db, sqlite);

    const result = await reconcile(vault, conversations, jobs);
    expect(result.scanned).toBe(1);
    expect(result.reinserted).toBe(1);
    expect(result.reenqueued).toBe(1);

    expect(conversations.exists(id)).toBe(true);
    expect(jobs.countByState("pending")).toBe(1);
    const claimed = jobs.claim();
    expect(claimed?.type).toBe("extract");
    expect(claimed?.payload.conversation_id).toBe(id);
    expect(claimed?.payload.conversation_path).toBe(
      `raw/conversations/2026/05/${id}.md`,
    );
  });

  it("simulates a missing .kh.db: archives, drops the DB, re-creates, reconciles, both rows restored", async () => {
    const { vault, db, sqlite } = await fresh();
    const config = loadConfig({
      skipGlobal: true,
      overrides: { vault: { path: vault }, git: { auto_commit: false } },
    });

    await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T10:00:00.000Z",
        messages: [{ role: "user", content: "first" }],
      },
    );
    await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T11:00:00.000Z",
        messages: [{ role: "user", content: "second" }],
      },
    );

    // Drop the database file — simulating a user deleting .kh.db.
    sqlite.close();
    openHandle = null;
    rmSync(join(vault, ".kh.db"), { force: true });
    rmSync(join(vault, ".kh.db-wal"), { force: true });
    rmSync(join(vault, ".kh.db-shm"), { force: true });

    // Re-open from scratch (migrations recreate the empty schema).
    const reopened = openTestDb(vault);
    openHandle = reopened.sqlite;
    const conversations = new ConversationsRepository(reopened.db);
    const jobs = new JobsRepository(reopened.db, reopened.sqlite);

    expect(conversations.count()).toBe(0);
    const result = await reconcile(vault, conversations, jobs);
    expect(result.scanned).toBe(2);
    expect(result.reinserted).toBe(2);
    expect(result.reenqueued).toBe(2);
    expect(conversations.count()).toBe(2);
    expect(jobs.countByState("pending")).toBe(2);
  });
});
