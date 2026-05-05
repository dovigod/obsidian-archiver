import { describe, expect, it } from "vitest";
import { SequentialQueue } from "@core/queue/sequential-queue";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SequentialQueue", () => {
  it("runs jobs strictly in submission order", async () => {
    const queue = new SequentialQueue();
    const order: number[] = [];
    const promises = Array.from({ length: 10 }, (_, i) =>
      queue.enqueue(async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        order.push(i);
        return i;
      }),
    );
    const results = await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("never overlaps jobs (only one runs at a time)", async () => {
    const queue = new SequentialQueue();
    let active = 0;
    let maxActive = 0;
    const job = async (): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 5 }, () => queue.enqueue(job)));
    expect(maxActive).toBe(1);
  });

  it("isolates failures: one job throwing does not break the next", async () => {
    const queue = new SequentialQueue();
    const failing = queue.enqueue(async () => {
      throw new Error("boom");
    });
    const succeeding = queue.enqueue(async () => 42);
    await expect(failing).rejects.toThrow(/boom/);
    expect(await succeeding).toBe(42);
  });

  it("depth reflects pending + running jobs", async () => {
    const queue = new SequentialQueue();
    const gate = deferred<void>();
    const first = queue.enqueue(async () => {
      await gate.promise;
    });
    const second = queue.enqueue(async () => 2);
    const third = queue.enqueue(async () => 3);
    expect(queue.depth).toBe(3);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(queue.depth).toBe(0);
  });
});
