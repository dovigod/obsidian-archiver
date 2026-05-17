import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { extract } from "tar";
import { createDb } from "@core/db/client";
import { vaultIsNonEmpty } from "@core/io/export";

export interface ImportOptions {
  /** Permits importing into a non-empty vault. Default false. */
  force?: boolean;
}

export interface ImportResult {
  vaultPath: string;
  /** True when a kh.sql dump was found and applied. */
  dbRestored: boolean;
  /** Files extracted (relative paths inside the vault). */
  extracted: number;
}

/**
 * Extract a knowledge-hub export bundle into `vaultPath`. Reconstructs the
 * SQLite database from the embedded `kh.sql` dump and re-runs drizzle
 * migrations on top (so older exports gain new columns automatically).
 */
export async function importVault(
  archivePath: string,
  vaultPath: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const absVault = resolve(vaultPath);

  if (!options.force && vaultIsNonEmpty(absVault)) {
    throw new Error(
      `import target "${absVault}" already has vault content; rerun with force=true to overwrite`,
    );
  }

  mkdirSync(absVault, { recursive: true });

  let extracted = 0;
  await extract({
    file: archivePath,
    cwd: absVault,
    onentry: () => {
      extracted += 1;
    },
  });

  const sqlPath = join(absVault, "kh.sql");
  let dbRestored = false;
  if (existsSync(sqlPath)) {
    const sqlText = readFileSync(sqlPath, "utf8");

    const dbPath = join(absVault, ".kh.db");
    // Wipe any existing DB + sidecars; we're replacing them from the dump.
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    // Open a fresh handle (migrations OFF initially — the dump already
    // carries the full schema). Then close and reopen with migrate: true
    // so any newer migrations on top apply cleanly. The FTS5 virtual table
    // gets populated by the existing triggers as the dump's INSERTs into
    // `entities` and `entity_aliases` replay.
    const fresh = createDb({ path: dbPath, migrate: false });
    try {
      fresh.sqlite.exec(sqlText);
    } finally {
      fresh.sqlite.close();
    }
    const upgraded = createDb({ path: dbPath, migrate: true });
    upgraded.sqlite.close();

    rmSync(sqlPath, { force: true });
    dbRestored = true;
  }

  return { vaultPath: absVault, dbRestored, extracted };
}
