import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FsQueue } from "@core/queue/fs-queue";
import { testTmpDir } from "./helpers";

describe("FsQueue", () => {
  it("roundtrips: enqueue -> claim -> complete", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-roundtrip-"));
    const q = new FsQueue(dir);
    await q.enqueue({ id: "j1", type: "classify", payload: { x: 1 } });

    const claimed = await q.claim();
    assert.equal(claimed?.id, "j1");
    assert.equal(claimed?.type, "classify");
    assert.deepEqual(claimed?.payload, { x: 1 });

    await q.complete("j1");
    assert.equal((await q.list("done")).length, 1);
    assert.equal((await q.list("pending")).length, 0);
    assert.equal((await q.list("running")).length, 0);
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
    assert.equal(a?.id, "0001");
    assert.equal(b?.id, "0002");
    assert.equal(c?.id, "0003");
  });

  it("two concurrent claimers don't both get the same job", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-race-"));
    const q1 = new FsQueue(dir);
    const q2 = new FsQueue(dir);
    await q1.enqueue({ id: "only", type: "x", payload: {} });

    const [a, b] = await Promise.all([q1.claim(), q2.claim()]);
    const winners = [a, b].filter((j): j is NonNullable<typeof a> => j !== null);
    assert.equal(winners.length, 1, "exactly one claimer should win");
    assert.equal(winners[0]?.id, "only");
  });

  it("fail moves job to failed/ with attempts incremented and error attached", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-fail-"));
    const q = new FsQueue(dir);
    await q.enqueue({ id: "boom", type: "x", payload: {} });
    await q.claim();
    await q.fail("boom", "kaboom");

    const failed = await q.list("failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.attempts, 1);
    assert.match(failed[0]?.error ?? "", /kaboom/);
    assert.equal((await q.list("running")).length, 0);
    assert.equal((await q.list("pending")).length, 0);
  });

  it("returns null when no pending jobs", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "fsq-empty-"));
    const q = new FsQueue(dir);
    assert.equal(await q.claim(), null);
  });
});
