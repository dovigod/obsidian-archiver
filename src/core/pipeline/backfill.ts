import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { archiveConversation, type ArchiveDeps } from "@core/archive";
import {
  type TranscriptSource,
  parsedToArchiveInput,
  parseTranscriptFromPath,
} from "@core/transcript";

export interface BackfillOptions {
  /** Force a specific parser instead of sniffing per-file. */
  source?: TranscriptSource;
  /** When true, walk and parse but don't write anything. */
  dryRun?: boolean;
}

export interface BackfillResult {
  scanned: number;
  imported: number;
  skipped: number;
  errors: { path: string; error: string }[];
}

const SUPPORTED_EXTENSIONS = new Set([".jsonl", ".json"]);

async function walkSync(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden / metadata dirs the user almost certainly doesn't want walked.
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      out.push(...(await walkSync(abs)));
      continue;
    }
    if (!entry.isFile()) {continue;}
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) {continue;}
    const ext = entry.name.slice(dot).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {continue;}
    out.push(abs);
  }
  return out;
}

/**
 * Walk `dir` for transcript files and archive each one with
 * `skipDuplicates: true`. The archive layer enforces idempotency via the
 * `content_hash` column added in migration `0001`.
 */
export async function backfill(
  deps: ArchiveDeps,
  dir: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    imported: 0,
    skipped: 0,
    errors: [],
  };

  let stats;
  try {
    stats = await stat(dir);
  } catch (err) {
    result.errors.push({ path: dir, error: (err as Error).message });
    return result;
  }
  if (!stats.isDirectory()) {
    result.errors.push({ path: dir, error: "not a directory" });
    return result;
  }

  const files = await walkSync(dir);

  for (const file of files) {
    try {
      const parsed = await parseTranscriptFromPath(
        file,
        options.source ? { source: options.source } : {},
      );
      for (const transcript of parsed) {
        result.scanned += 1;
        if (transcript.messages.length === 0) {continue;}
        if (options.dryRun) {continue;}

        const archiveInput = parsedToArchiveInput(transcript, {
          source: options.source ?? sniffSourceFromPath(file),
        });
        const ar = await archiveConversation(deps, archiveInput, {
          skipDuplicates: true,
        });
        if (ar.skippedDuplicate) {
          result.skipped += 1;
        } else {
          result.imported += 1;
        }
      }
    } catch (err) {
      result.errors.push({ path: file, error: (err as Error).message });
    }
  }

  return result;
}

function sniffSourceFromPath(path: string): TranscriptSource {
  const lower = path.toLowerCase();
  if (lower.endsWith("conversations.json")) {return "chatgpt";}
  if (lower.endsWith("myactivity.json")) {return "gemini";}
  return "claude-code";
}
