import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simpleGit } from "simple-git";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_RESULT_DIR = resolve(here, "..", "test_result");

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
 *
 * Production callers let `autoCommit` lazily `git init` the vault on first
 * commit, but that inherits the user's global git config — which on some
 * machines requires GPG signing or has no `user.email`/`user.name` set, both
 * of which break unattended test commits. Repo-local config wins over global,
 * so seeding the repo here keeps the test-only escape hatch off the
 * production hot path. `autoCommit` sees `.git/` already present and skips
 * its own init step.
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
