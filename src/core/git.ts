import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface GitAutoCommitOptions {
  /** Vault root. We treat this as the git working tree. */
  vaultPath: string;
  /** Files to stage, relative to vaultPath OR absolute. */
  files: string[];
  /** Commit message. */
  message: string;
}

/** Detects `index.lock` contention from concurrent git invocations. */
function isIndexLockError(err: unknown): boolean {
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === "string" && msg.includes("index.lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backoff schedule used when a concurrent process holds `.git/index.lock`.
 * In-process callers are already serialized via `SequentialQueue`, but
 * Stop hooks spawn fresh `kh archive-transcript` processes that bypass it,
 * so we need cross-process tolerance at the git layer.
 */
const INDEX_LOCK_RETRY_DELAYS_MS = [50, 150, 300] as const;

/**
 * Initializes a vault as a git repo on first use, then stages and commits the
 * given files. No-ops gracefully if `vaultPath` does not exist yet.
 *
 * Failures are non-fatal: we log to stderr and return false so the calling
 * pipeline (e.g. a Stop hook) does not block on git problems.
 */
export async function autoCommit(opts: GitAutoCommitOptions): Promise<boolean> {
  const { vaultPath, files, message } = opts;
  if (!existsSync(vaultPath)) {
    return false;
  }
  if (files.length === 0) {
    return false;
  }

  const git: SimpleGit = simpleGit({ baseDir: vaultPath });
  let lastError: unknown;
  for (let attempt = 0; attempt <= INDEX_LOCK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      if (!existsSync(join(vaultPath, ".git"))) {
        await git.init();
      }
      await git.add(files);
      const status = await git.status();
      if (status.staged.length === 0 && status.created.length === 0) {
        return false;
      }
      await git.commit(message);
      return true;
    } catch (err) {
      lastError = err;
      if (
        isIndexLockError(err) &&
        attempt < INDEX_LOCK_RETRY_DELAYS_MS.length
      ) {
        await sleep(INDEX_LOCK_RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      break;
    }
  }
  process.stderr.write(
    `[knowledge-hub] git auto-commit failed: ${(lastError as Error).message}\n`,
  );
  return false;
}
