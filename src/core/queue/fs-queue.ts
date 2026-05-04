import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type JobState = "pending" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  enqueued_at: string;
  attempts: number;
  error?: string;
}

export interface EnqueueInput {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Filesystem-backed cross-process job queue.
 *
 * Layout:
 *   <root>/pending/{jobId}.json    — waiting for a worker
 *   <root>/running/{jobId}.json    — claimed by a worker
 *   <root>/done/{jobId}.json       — succeeded
 *   <root>/failed/{jobId}.json     — failed (with error + attempt count)
 *
 * `claim` uses `rename` for atomic claim semantics: only one process can
 * successfully rename a given pending file into running/. Losing claimers
 * see ENOENT and try the next pending file.
 */
export class FsQueue {
  constructor(private readonly root: string) {}

  private dir(state: JobState): string {
    return join(this.root, state);
  }

  async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.dir("pending"), { recursive: true }),
      mkdir(this.dir("running"), { recursive: true }),
      mkdir(this.dir("done"), { recursive: true }),
      mkdir(this.dir("failed"), { recursive: true }),
    ]);
  }

  async enqueue(input: EnqueueInput): Promise<string> {
    await this.ensureDirs();
    const record: JobRecord = {
      id: input.id,
      type: input.type,
      payload: input.payload,
      enqueued_at: new Date().toISOString(),
      attempts: 0,
    };
    const path = join(this.dir("pending"), `${input.id}.json`);
    await writeFile(path, JSON.stringify(record, null, 2), "utf8");
    return input.id;
  }

  /** Atomically claim the oldest pending job. Returns null when none. */
  async claim(): Promise<JobRecord | null> {
    await this.ensureDirs();
    const files = (await readdir(this.dir("pending")))
      .filter((f) => f.endsWith(".json"))
      .sort(); // uuid v7 is time-ordered → lexicographic == enqueue order
    for (const file of files) {
      const src = join(this.dir("pending"), file);
      const dst = join(this.dir("running"), file);
      try {
        await rename(src, dst);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw err;
      }
      const text = await readFile(dst, "utf8");
      return JSON.parse(text) as JobRecord;
    }
    return null;
  }

  async complete(jobId: string): Promise<void> {
    const src = join(this.dir("running"), `${jobId}.json`);
    const dst = join(this.dir("done"), `${jobId}.json`);
    await rename(src, dst);
  }

  async fail(jobId: string, error: string): Promise<void> {
    const src = join(this.dir("running"), `${jobId}.json`);
    const text = await readFile(src, "utf8");
    const record = JSON.parse(text) as JobRecord;
    record.attempts += 1;
    record.error = error;
    const dst = join(this.dir("failed"), `${jobId}.json`);
    await writeFile(dst, JSON.stringify(record, null, 2), "utf8");
    await rm(src, { force: true });
  }

  async list(state: JobState): Promise<JobRecord[]> {
    if (!existsSync(this.dir(state))) {
      return [];
    }
    const files = (await readdir(this.dir(state)))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const out: JobRecord[] = [];
    for (const file of files) {
      const text = await readFile(join(this.dir(state), file), "utf8");
      out.push(JSON.parse(text) as JobRecord);
    }
    return out;
  }
}
