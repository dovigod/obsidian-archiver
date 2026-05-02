interface QueueJob<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * In-process FIFO that runs at most one async job at a time.
 *
 * Stage 1 design choice: every conversation-processing request (MCP
 * `archive_conversation`, future tools) flows through one shared queue so
 * the whole pipeline — write to vault, git commit, and later
 * classify/synthesize — is serialized. Sequential drain replaces every
 * per-resource lock we would otherwise need.
 *
 * A failing job rejects only its own caller; the drain loop continues with
 * the next job.
 */
export class SequentialQueue {
  private readonly jobs: Array<QueueJob<unknown>> = [];
  private running = false;

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  /** Pending + currently-running. */
  get depth(): number {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!;
        try {
          const result = await job.run();
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
