import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@core/db/schema";

export type DB = BetterSQLite3Database<typeof schema>;
export type SqliteHandle = Database.Database;

export interface CreateDbOptions {
  /** Absolute filesystem path to the .kh.db file (or `:memory:`). */
  path: string;
  journalMode?: "WAL" | "DELETE" | "MEMORY";
  busyTimeoutMs?: number;
  synchronous?: "OFF" | "NORMAL" | "FULL";
  /** When true, run drizzle migrations from `migrationsFolder` on open. */
  migrate?: boolean;
  /**
   * Absolute path to the migrations directory. Defaults to the `drizzle/`
   * folder shipped alongside the compiled source.
   */
  migrationsFolder?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS = resolve(here, "..", "..", "..", "drizzle");

/**
 * Opens (or creates) the SQLite database at `path`. Always enables WAL +
 * foreign keys + a generous `busy_timeout` so concurrent writers wait
 * rather than error.
 *
 * Caller owns the lifecycle: call `sqlite.close()` on shutdown.
 */
export function createDb(opts: CreateDbOptions): {
  db: DB;
  sqlite: SqliteHandle;
} {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const sqlite = new Database(opts.path);
  sqlite.pragma(`journal_mode = ${opts.journalMode ?? "WAL"}`);
  sqlite.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  sqlite.pragma(`synchronous = ${opts.synchronous ?? "NORMAL"}`);
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  if (opts.migrate) {
    migrate(db, {
      migrationsFolder: opts.migrationsFolder ?? DEFAULT_MIGRATIONS,
    });
  }

  return { db, sqlite };
}

export { schema };
