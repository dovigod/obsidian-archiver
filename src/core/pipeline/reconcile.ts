import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import matter from "gray-matter";
import { newId } from "@core/ids";
import type { ConversationsRepository } from "@core/db/repository/conversations";
import type { JobsRepository } from "@core/db/repository/jobs";

export interface ReconcileResult {
  scanned: number;
  reinserted: number;
  reenqueued: number;
}

/**
 * Walk `vault/raw/conversations/**` and ensure every md has a corresponding
 * `conversations` row. For any orphan, insert the row from frontmatter and
 * enqueue a fresh `extract` job. Recovery path when:
 *   - the SQLite db is deleted or corrupted
 *   - capture fired but the DB INSERT failed
 *   - the vault was cloned without `.kh.db`
 */
export async function reconcile(
  vaultPath: string,
  conversationsRepo: ConversationsRepository,
  jobsRepo: JobsRepository,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    scanned: 0,
    reinserted: 0,
    reenqueued: 0,
  };

  const rawDir = join(resolve(vaultPath), "raw", "conversations");
  if (!existsSync(rawDir)) {
    return result;
  }

  for await (const file of walkMarkdown(rawDir)) {
    result.scanned += 1;
    const text = await readFile(file, "utf8");
    const parsed = matter(text);
    const id =
      typeof parsed.data.id === "string" ? parsed.data.id : null;
    if (!id) {
      continue;
    }
    const relativePath = file
      .slice(resolve(vaultPath).length + 1)
      .split(sep)
      .join("/");

    if (!conversationsRepo.exists(id)) {
      const createdAtIso =
        (parsed.data.created_at as string | undefined) ??
        new Date().toISOString();
      conversationsRepo.create({
        id,
        source: (parsed.data.source as string) ?? "unknown",
        model:
          typeof parsed.data.model === "string" ? parsed.data.model : undefined,
        createdAt: Date.parse(createdAtIso),
        project: asStringArray(parsed.data.project),
        topics: asStringArray(parsed.data.topics),
        conversationType: asStringArray(parsed.data.conversation_type),
        tags: asStringArray(parsed.data.tags),
        git: parsed.data.git as
          | { repo?: string; branch?: string; commit?: string }
          | undefined,
        cwd: typeof parsed.data.cwd === "string" ? parsed.data.cwd : undefined,
        rawPath: relativePath,
      });
      result.reinserted += 1;

      jobsRepo.enqueue({
        id: newId(),
        type: "extract",
        payload: { conversation_id: id, conversation_path: relativePath },
      });
      result.reenqueued += 1;
    }
  }

  return result;
}

async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}
