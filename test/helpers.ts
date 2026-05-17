import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";
import { createDb, type DB, type SqliteHandle } from "@core/db/client";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_RESULT_DIR = resolve(here, "..", "test_result");
const DRIZZLE_DIR = resolve(here, "..", "drizzle");

/**
 * Returns the project-local `<repo>/test_result/` directory used as the parent
 * for `mkdtempSync` calls in tests.
 *
 * The directory is wiped before each `npm test` run via the `pretest` script
 * (so we don't race here across worker processes — each test file forks its
 * own Node process). Workers only ensure the directory exists.
 */
export function testTmpDir(): string {
  mkdirSync(TEST_RESULT_DIR, { recursive: true });
  return TEST_RESULT_DIR;
}

/**
 * Pre-initializes a vault directory as a git repo with test-safe local config.
 */
export async function prepareVaultRepo(vaultPath: string): Promise<void> {
  mkdirSync(vaultPath, { recursive: true });
  const git = simpleGit({ baseDir: vaultPath });
  await git.init();
  await git.addConfig("commit.gpgsign", "false", false, "local");
  await git.addConfig("tag.gpgsign", "false", false, "local");
  await git.addConfig("user.email", "test@knowledge-hub.local", false, "local");
  await git.addConfig("user.name", "knowledge-hub-test", false, "local");
}

/**
 * Open a fresh test database with migrations applied. By default uses a file
 * inside the vault so it survives across helper calls within one test;
 * pass `inMemory: true` for a one-off `:memory:` DB.
 */
export function openTestDb(
  vaultPath: string,
  options: { inMemory?: boolean } = {},
): { db: DB; sqlite: SqliteHandle } {
  const path = options.inMemory ? ":memory:" : join(vaultPath, ".kh.db");
  return createDb({
    path,
    journalMode: options.inMemory ? "MEMORY" : "WAL",
    migrate: true,
    migrationsFolder: DRIZZLE_DIR,
  });
}
