import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobsRepository } from "@core/db/repository/jobs";
import type { SqliteHandle } from "@core/db/client";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("JobsRepository (SQLite-backed queue)", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function fresh() {
    const dir = mkdtempSync(join(testTmpDir(), "sqlite-queue-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    return new JobsRepository(db, sqlite);
  }

  it("enqueue then claim returns the same job", async () => {
    const jobs = await fresh();
    jobs.enqueue({ id: "j1", type: "extract", payload: { x: 1 } });
    const claimed = jobs.claim();
    expect(claimed?.id).toBe("j1");
    expect(claimed?.type).toBe("extract");
    expect(claimed?.payload).toEqual({ x: 1 });
    expect(claimed?.attempts).toBe(1);
  });

  it("claim is atomic: second claim of same backlog returns the next job, not a duplicate", async () => {
    const jobs = await fresh();
    jobs.enqueue({ id: "a", type: "extract", payload: {} }, 1);
    jobs.enqueue({ id: "b", type: "extract", payload: {} }, 2);

    const first = jobs.claim();
    const second = jobs.claim();
    expect(first?.id).toBe("a");
    expect(second?.id).toBe("b");
    expect(jobs.claim()).toBeNull();
  });

  it("complete moves a running job to done", async () => {
    const jobs = await fresh();
    jobs.enqueue({ id: "j", type: "extract", payload: {} });
    const claimed = jobs.claim()!;
    jobs.complete(claimed.id);
    const row = jobs.findById(claimed.id)!;
    expect(row.state).toBe("done");
    expect(row.finishedAt).not.toBeNull();
  });

  it("fail re-enqueues until max_attempts, then dead-letters to failed", async () => {
    const jobs = await fresh();
    jobs.enqueue({ id: "k", type: "extract", payload: {} });

    for (let i = 0; i < 4; i++) {
      const claimed = jobs.claim()!;
      expect(claimed.id).toBe("k");
      jobs.fail("k", `attempt ${i + 1}`, 5);
      const row = jobs.findById("k")!;
      expect(row.state).toBe("pending");
    }
    const last = jobs.claim()!;
    expect(last.attempts).toBe(5);
    jobs.fail("k", "final", 5);
    const dead = jobs.findById("k")!;
    expect(dead.state).toBe("failed");
    expect(dead.lastError).toBe("final");
  });

  it("reclaimStuck flips expired running leases back to pending", async () => {
    const jobs = await fresh();
    jobs.enqueue({ id: "stale", type: "extract", payload: {} });
    jobs.claim({ leaseMs: 1, now: 1000 });
    // lease_until is 1001; reclaim with now > 1001
    const recovered = jobs.reclaimStuck(2000);
    expect(recovered).toBe(1);
    const row = jobs.findById("stale")!;
    expect(row.state).toBe("pending");
    expect(row.leaseUntil).toBeNull();
  });

  it("claim is FIFO by enqueue order", async () => {
    const jobs = await fresh();
    jobs.enqueue({ id: "a", type: "extract", payload: {} }, 100);
    jobs.enqueue({ id: "b", type: "extract", payload: {} }, 200);
    jobs.enqueue({ id: "c", type: "extract", payload: {} }, 300);
    expect(jobs.claim()?.id).toBe("a");
    expect(jobs.claim()?.id).toBe("b");
    expect(jobs.claim()?.id).toBe("c");
  });
});
