import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { create } from "tar";
import type { SqliteHandle } from "@core/db/client";

/** Subdirectories of the vault that are bundled into the export. */
const VAULT_PORTABLE_DIRS = [
  "raw",
  "knowledge",
  "_proposals",
] as const;

/** Top-level files we include if they exist. */
const VAULT_PORTABLE_FILES = [
  ".gitignore",
  "SMART_CONNECTIONS.md",
] as const;

export interface ExportOptions {
  /** Defaults to `<vault>/_exports/kh-export-<ISO>.tar.gz`. */
  outputPath?: string;
}

export interface ExportResult {
  outputPath: string;
  /** Vault-root-relative paths included in the archive. */
  files: string[];
}

/**
 * Bundle the vault into a portable `.tar.gz`. SQLite contents are dumped as
 * a `kh.sql` text file so the bundle round-trips across SQLite versions.
 * Excludes ephemeral state: `.kh.db*` binaries, `.smart-env/`, prior exports,
 * `node_modules` (defensive).
 */
export async function exportVault(
  vaultPath: string,
  sqlite: SqliteHandle,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const absVault = resolve(vaultPath);
  const exportsDir = join(absVault, "_exports");
  mkdirSync(exportsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    options.outputPath ?? join(exportsDir, `kh-export-${stamp}.tar.gz`);

  // 1. Materialize the SQL dump to disk so it can join the tar stream alongside
  //    the regular vault files. Lives at the vault root for the bundle and is
  //    removed after.
  const sqlPath = join(absVault, "kh.sql");
  const sqlText = dumpSqlite(sqlite);
  writeFileSync(sqlPath, sqlText, "utf8");

  const included: string[] = [];
  for (const dir of VAULT_PORTABLE_DIRS) {
    if (existsSync(join(absVault, dir))) {
      included.push(dir);
    }
  }
  for (const file of VAULT_PORTABLE_FILES) {
    if (existsSync(join(absVault, file))) {
      included.push(file);
    }
  }
  included.push("kh.sql");

  try {
    await create(
      {
        gzip: true,
        cwd: absVault,
        file: outputPath,
        portable: true,
      },
      included,
    );
  } finally {
    await rm(sqlPath, { force: true });
  }

  return { outputPath, files: included };
}

/**
 * SQLite text dump compatible with `sqlite3 .kh.db .dump`. Iterates schema +
 * data via the better-sqlite3 handle to avoid shelling out to the sqlite3
 * CLI (which isn't guaranteed to be on PATH).
 *
 * FTS5 shadow tables (`<vtab>_data`, `_idx`, `_content`, `_docsize`,
 * `_config`) are intentionally skipped — they're auto-created by the
 * CREATE VIRTUAL TABLE statement and the indexed contents are rebuilt by
 * the schema's triggers after data load.
 */
function dumpSqlite(sqlite: SqliteHandle): string {
  const out: string[] = [];
  out.push("PRAGMA foreign_keys=OFF;");
  out.push("BEGIN TRANSACTION;");

  const virtualTables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'`,
    )
    .all() as { name: string }[];
  const virtualNames = virtualTables.map((r) => r.name);

  const isShadow = (name: string): boolean =>
    virtualNames.some((v) => name.startsWith(`${v}_`));

  // Schema first — virtual tables before their consumers, then regular
  // tables, then indexes, then triggers.
  const schemaRows = sqlite
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE
                  WHEN sql LIKE 'CREATE VIRTUAL%' THEN 1
                  WHEN type = 'table'             THEN 2
                  WHEN type = 'index'             THEN 3
                  WHEN type = 'trigger'           THEN 4
                  ELSE 5
                END`,
    )
    .all() as { type: string; name: string; sql: string }[];

  for (const row of schemaRows) {
    if (isShadow(row.name)) {continue;}
    // Drizzle auto-creates UNIQUE indexes for `unique()` columns; the same
    // index gets emitted via the table CREATE. Skip the standalone CREATE
    // INDEX so replay doesn't error with "already exists".
    if (row.type === "index" && row.name.endsWith("_unique")) {continue;}
    out.push(`${row.sql};`);
  }

  // Data — every regular (non-virtual, non-shadow) table.
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND sql NOT LIKE 'CREATE VIRTUAL%'`,
    )
    .all() as { name: string }[];

  for (const { name } of tables) {
    if (isShadow(name)) {continue;}
    const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => sqliteLiteral(row[c]));
      out.push(
        `INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals.join(", ")});`,
      );
    }
  }

  out.push("COMMIT;");
  return out.join("\n");
}

function sqliteLiteral(value: unknown): string {
  if (value === null || value === undefined) {return "NULL";}
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "bigint") {return value.toString();}
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return `X'${buf.toString("hex")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function vaultIsNonEmpty(vaultPath: string): boolean {
  if (!existsSync(vaultPath)) {return false;}
  try {
    const s = statSync(vaultPath);
    if (!s.isDirectory()) {return false;}
    const interesting = ["raw", "knowledge", ".kh.db"].some((p) =>
      existsSync(join(vaultPath, p)),
    );
    return interesting;
  } catch {
    return false;
  }
}
