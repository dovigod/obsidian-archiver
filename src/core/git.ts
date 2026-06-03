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

export interface GitPushOptions {
  /** Vault root (git working tree). */
  vaultPath: string;
  /** Remote name. Defaults to "origin". */
  remote?: string;
  /** Branch to push. Empty/omitted = currently checked-out branch. */
  branch?: string;
  /**
   * Access token for https remotes (GitHub PAT etc.). Pushed via a one-off
   * authenticated URL — never written to git config. Ignored for SSH remotes.
   */
  token?: string;
}

/**
 * Build a one-off authenticated push URL for an https remote.
 * Returns null for non-https remotes (SSH pushes use keys as usual).
 */
export function injectTokenIntoRemoteUrl(
  url: string,
  token: string,
): string | null {
  if (!url.startsWith("https://")) {
    return null;
  }
  return `https://x-access-token:${encodeURIComponent(token)}@${url.slice("https://".length)}`;
}

/** Resolve the push token: explicit config value first, then the named env var. */
export function resolvePushToken(push: {
  token?: string;
  token_env: string;
}): string | undefined {
  return push.token ?? process.env[push.token_env] ?? undefined;
}

/**
 * Push the vault to its configured remote. Mirrors autoCommit's failure
 * philosophy: never throws — logs to stderr and returns false so archiving
 * is not blocked by network/auth problems.
 */
export async function pushVault(opts: GitPushOptions): Promise<boolean> {
  const { vaultPath } = opts;
  const remoteName = opts.remote ?? "origin";
  if (!existsSync(join(vaultPath, ".git"))) {
    return false;
  }
  const git: SimpleGit = simpleGit({ baseDir: vaultPath });
  try {
    const remotes = await git.getRemotes(true);
    const remote = remotes.find((r) => r.name === remoteName);
    if (!remote) {
      process.stderr.write(
        `[knowledge-hub] git auto-push skipped: no remote "${remoteName}" configured in ${vaultPath}\n`,
      );
      return false;
    }
    const branch =
      opts.branch && opts.branch !== ""
        ? opts.branch
        : (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

    const remoteUrl = remote.refs.push || remote.refs.fetch;
    const authedUrl = opts.token
      ? injectTokenIntoRemoteUrl(remoteUrl, opts.token)
      : null;
    if (authedUrl) {
      await git.push(authedUrl, `HEAD:${branch}`);
    } else {
      await git.push(remoteName, branch);
    }
    return true;
  } catch (err) {
    // Strip any token that leaked into the error message (simple-git echoes
    // the remote URL on failure).
    const msg = (err as Error).message.replace(
      /x-access-token:[^@]+@/g,
      "x-access-token:***@",
    );
    process.stderr.write(`[knowledge-hub] git auto-push failed: ${msg}\n`);
    return false;
  }
}
