import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { JobsRepository } from "@core/db/repository/jobs";
import { MockLLMProvider } from "@core/llm/mock";
import { SequentialQueue } from "@core/queue/sequential-queue";
import { runWorker } from "@core/worker";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

const EXTRACT_RESPONSE = JSON.stringify({
  entities: [
    {
      name: "Redis",
      summary: "In-memory key-value store.",
      tags: ["storage"],
      aliases: [],
      draft_body: "## Overview\n\nRedis is an in-memory key-value store.\n",
    },
  ],
});

describe("runWorker (in-process drain)", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup(): Promise<{
    config: ReturnType<typeof loadConfig>;
    db: DB;
    sqlite: SqliteHandle;
    vault: string;
  }> {
    const dir = mkdtempSync(join(testTmpDir(), "worker-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
        logging: { enabled: false },
        extract: { enabled: true },
      },
    });
    const opened = openTestDb(vault);
    openHandle = opened.sqlite;
    return { config, db: opened.db, sqlite: opened.sqlite, vault };
  }

  /** Scripts both Stage 2 jobs: extract → entity, notes-plan → one note. */
  function scriptStage2(llm: MockLLMProvider): void {
    llm.respondWhen(/extracting reusable knowledge entities/, EXTRACT_RESPONSE);
    llm.respondWhen(
      /planning how to distill/,
      JSON.stringify({
        notes: [
          {
            action: "create",
            title: "Redis",
            topics: ["redis"],
            assistant_indexes: [0],
            needs_canvas: false,
          },
        ],
      }),
    );
    llm.respondWhen(
      /transcribing assistant answers/,
      "## Overview\n\n[[Redis]] is an in-memory KV store used for caching.\n",
    );
    // Re-ask path (full conversations route here): plan from user questions,
    // then regenerate a bilingual answer.
    llm.respondWhen(
      /planning how to turn one archived conversation/,
      JSON.stringify({
        notes: [
          {
            title: "Redis",
            topics: ["redis"],
            question_indexes: [0],
            needs_canvas: false,
          },
        ],
      }),
    );
    llm.respondWhen(
      /answering the user's questions yourself/,
      "## 개요\n\n[[Redis]]는 인메모리 KV 저장소.\n\n---\n\n## English\n\n### Overview\n\n[[Redis]] is an in-memory KV store.\n",
    );
  }

  it("once-mode drains queued extract + notes jobs to done and renders both outputs", async () => {
    const { config, db, sqlite, vault } = await setup();
    const llm = new MockLLMProvider();
    scriptStage2(llm);

    const archived = await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-06-01T10:00:00.000Z",
        messages: [
          { role: "user", content: "What is Redis good for?" },
          { role: "assistant", content: "Caching — it is an in-memory KV store." },
        ],
      },
    );

    const jobsRepo = new JobsRepository(db, sqlite);
    expect(jobsRepo.countByState("pending")).toBe(2);

    await runWorker({ once: true, config, db, sqlite, llm });

    expect(jobsRepo.countByState("pending")).toBe(0);
    expect(jobsRepo.findById(archived.extractJobId)?.state).toBe("done");
    expect(jobsRepo.findById(archived.notesJobId)?.state).toBe("done");
    expect(existsSync(join(vault, "knowledge", "Redis.md"))).toBe(true);
    expect(existsSync(join(vault, "notes", "Redis.md"))).toBe(true);
  });

  it("routes job processing through the injected serialize hook", async () => {
    const { config, db, sqlite } = await setup();
    const llm = new MockLLMProvider();
    scriptStage2(llm);

    await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-06-01T11:00:00.000Z",
        messages: [
          { role: "user", content: "Tell me about Redis." },
          { role: "assistant", content: "Redis is an in-memory KV store." },
        ],
      },
    );

    const queue = new SequentialQueue();
    let serialized = 0;
    await runWorker({
      once: true,
      config,
      db,
      sqlite,
      llm,
      serialize: (fn) => {
        serialized += 1;
        return queue.enqueue(fn);
      },
    });

    expect(serialized).toBe(2);
    const jobsRepo = new JobsRepository(db, sqlite);
    expect(jobsRepo.countByState("done")).toBe(2);
  });

  it("stops a continuous drain loop when the abort signal fires", async () => {
    const { config, db, sqlite } = await setup();
    const llm = new MockLLMProvider();

    const abort = new AbortController();
    const done = runWorker({
      config,
      db,
      sqlite,
      llm,
      pollIntervalMs: 10_000, // long idle wait — abort must cut it short
      signal: abort.signal,
    });

    abort.abort();
    // Resolves promptly instead of waiting out the poll interval.
    await expect(done).resolves.toBeUndefined();
  });
});
