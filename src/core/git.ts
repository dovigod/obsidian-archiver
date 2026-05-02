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
    process.stderr.write(
      `[knowledge-hub] git auto-commit failed: ${(err as Error).message}\n`,
    );
    return false;
  }
}
