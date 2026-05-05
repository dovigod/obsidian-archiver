import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsQueue } from "@core/queue/fs-queue";
import { testTmpDir } from "./helpers";

describe("FsQueue", () => {
  it("roundtrips: enqueue -> claim -> complete", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-roundtrip-"));
    const q = new FsQueue(dir);
    await q.enqueue({ id: "j1", type: "classify", payload: { x: 1 } });

    const claimed = await q.claim();
    expect(claimed?.id).toBe("j1");
    expect(claimed?.type).toBe("classify");
    expect(claimed?.payload).toEqual({ x: 1 });

    await q.complete("j1");
    expect((await q.list("done")).length).toBe(1);
    expect((await q.list("pending")).length).toBe(0);
    expect((await q.list("running")).length).toBe(0);
  });

  it("FIFO via lexicographic sort (uuid v7 is time-ordered)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-fifo-"));
    const q = new FsQueue(dir);
    await q.enqueue({ id: "0001", type: "x", payload: {} });
    await q.enqueue({ id: "0002", type: "x", payload: {} });
    await q.enqueue({ id: "0003", type: "x", payload: {} });

    const a = await q.claim();
    const b = await q.claim();
    const c = await q.claim();
    expect(a?.id).toBe("0001");
    expect(b?.id).toBe("0002");
    expect(c?.id).toBe("0003");
  });

  it("two concurrent claimers don't both get the same job", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-race-"));
    const q1 = new FsQueue(dir);
    const q2 = new FsQueue(dir);
    await q1.enqueue({ id: "only", type: "x", payload: {} });

    const [a, b] = await Promise.all([q1.claim(), q2.claim()]);
    const winners = [a, b].filter((j): j is NonNullable<typeof a> => j !== null);
    expect(winners.length).toBe(1);
    expect(winners[0]?.id).toBe("only");
  });

  it("fail moves job to failed/ with attempts incremented and error attached", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-fail-"));
    const q = new FsQueue(dir);
    await q.enqueue({ id: "boom", type: "x", payload: {} });
    await q.claim();
    await q.fail("boom", "kaboom");

    const failed = await q.list("failed");
    expect(failed.length).toBe(1);
    expect(failed[0]?.attempts).toBe(1);
    expect(failed[0]?.error ?? "").toMatch(/kaboom/);
    expect((await q.list("running")).length).toBe(0);
    expect((await q.list("pending")).length).toBe(0);
  });

  it("returns null when no pending jobs", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-empty-"));
    const q = new FsQueue(dir);
    expect(await q.claim()).toBeNull();
  });
});
