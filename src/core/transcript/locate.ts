import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code stores session transcripts under
 * `~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl`, where the munged
 * cwd replaces every non-alphanumeric character with `-`
 * (e.g. `/a/b_c.d` → `-a-b-c-d`).
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export interface LocateSessionOptions {
  /** Working directory of the Claude Code session. */
  cwd: string;
  /** Explicit session UUID. When omitted, the most recently modified session wins. */
  sessionId?: string;
  /** Override for tests. Defaults to `~/.claude/projects`. */
  projectsRoot?: string;
}

/**
 * Resolve the on-disk JSONL transcript for a Claude Code session. Reading the
 * transcript from disk is the only way to archive the WHOLE session — asking
 * the calling model to serialize its history only captures what it chooses
 * to copy into the tool arguments.
 */
export async function locateClaudeSessionTranscript(
  options: LocateSessionOptions,
): Promise<string> {
  const root = options.projectsRoot ?? defaultClaudeProjectsRoot();
  const projectDir = join(root, claudeProjectDirName(options.cwd));

  if (options.sessionId) {
    const path = join(projectDir, `${options.sessionId}.jsonl`);
    try {
      await stat(path);
    } catch {
      throw new Error(
        `No transcript for session ${options.sessionId} under ${projectDir}`,
      );
    }
    return path;
  }

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    throw new Error(
      `No Claude Code project directory for cwd "${options.cwd}" ` +
        `(looked at ${projectDir})`,
    );
  }

  let newest: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    const path = join(projectDir, entry);
    const info = await stat(path);
    if (!info.isFile()) {
      continue;
    }
    if (!newest || info.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: info.mtimeMs };
    }
  }
  if (!newest) {
    throw new Error(`No session transcripts (*.jsonl) found in ${projectDir}`);
  }
  return newest.path;
}
