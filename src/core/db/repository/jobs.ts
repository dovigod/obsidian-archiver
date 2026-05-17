import { and, eq, lt, sql } from "drizzle-orm";
import type { DB, SqliteHandle } from "@core/db/client";
import { jobs, type JobRow, type JobState, type JobType } from "@core/db/schema";

export interface EnqueueInput {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
}

export interface ClaimOptions {
  /** Lease duration in ms. Defaults to 60_000. */
  leaseMs?: number;
  now?: number;
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  enqueuedAt: number;
  startedAt: number;
  leaseUntil: number;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * SQLite-backed job queue. Replaces the filesystem-based FsQueue from the
 * pre-pivot design. Claim is atomic via `BEGIN IMMEDIATE` + a single
 * `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` round-trip.
 *
 * Note the constructor takes both the drizzle handle and the raw
 * better-sqlite3 handle — the atomic claim is one prepared statement
 * easier to express in raw SQL than in drizzle's builder.
 */
export class JobsRepository {
  constructor(
    private readonly db: DB,
    private readonly sqlite: SqliteHandle,
  ) {}

  enqueue(input: EnqueueInput, now: number = Date.now()): string {
    this.db
      .insert(jobs)
      .values({
        id: input.id,
        type: input.type,
        payloadJson: JSON.stringify(input.payload),
        state: "pending",
        attempts: 0,
        enqueuedAt: now,
      })
      .run();
    return input.id;
  }

  /**
   * Atomically claim the oldest pending job. Returns null when none.
   *
   * A single UPDATE...WHERE id=(SELECT...LIMIT 1)...RETURNING is the unit of
   * atomicity — SQLite serializes writers under WAL, so concurrent callers
   * either see the row gone or pick a different one.
   */
  claim(options: ClaimOptions = {}): ClaimedJob | null {
    const now = options.now ?? Date.now();
    const leaseUntil = now + (options.leaseMs ?? DEFAULT_LEASE_MS);

    const stmt = this.sqlite.prepare(`
      UPDATE jobs
      SET state = 'running',
          started_at = @now,
          lease_until = @leaseUntil,
          attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
        WHERE state = 'pending'
        ORDER BY enqueued_at ASC
        LIMIT 1
      )
      RETURNING id, type, payload_json, attempts, enqueued_at, started_at, lease_until
    `);

    const row = stmt.get({ now, leaseUntil }) as
      | {
          id: string;
          type: string;
          payload_json: string;
          attempts: number;
          enqueued_at: number;
          started_at: number;
          lease_until: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      attempts: row.attempts,
      enqueuedAt: row.enqueued_at,
      startedAt: row.started_at,
      leaseUntil: row.lease_until,
    };
  }

  complete(jobId: string, now: number = Date.now()): void {
    this.db
      .update(jobs)
      .set({
        state: "done",
        finishedAt: now,
        leaseUntil: null,
        lastError: null,
      })
      .where(eq(jobs.id, jobId))
      .run();
  }

  /**
   * Mark a job failed. If `attempts < maxAttempts`, re-enqueues by flipping
   * back to 'pending'. Otherwise dead-letters to 'failed' with the error.
   */
  fail(
    jobId: string,
    error: string,
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    now: number = Date.now(),
  ): void {
    const current = this.db
      .select({ attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (!current) {
      return;
    }
    if (current.attempts >= maxAttempts) {
      this.db
        .update(jobs)
        .set({
          state: "failed",
          finishedAt: now,
          leaseUntil: null,
          lastError: error,
        })
        .where(eq(jobs.id, jobId))
        .run();
    } else {
      this.db
        .update(jobs)
        .set({
          state: "pending",
          startedAt: null,
          leaseUntil: null,
          lastError: error,
        })
        .where(eq(jobs.id, jobId))
        .run();
    }
  }

  /**
   * Reclaim any `running` jobs whose lease has expired (worker crashed).
   * Returns the count of reclaimed jobs.
   */
  reclaimStuck(now: number = Date.now()): number {
    const result = this.db
      .update(jobs)
      .set({ state: "pending", leaseUntil: null })
      .where(and(eq(jobs.state, "running"), lt(jobs.leaseUntil, now)))
      .run();
    return Number(result.changes ?? 0);
  }

  list(state: JobState): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.state, state))
      .all();
  }

  countByState(state: JobState): number {
    const row = this.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(jobs)
      .where(eq(jobs.state, state))
      .get();
    return row?.c ?? 0;
  }

  findById(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }
}
