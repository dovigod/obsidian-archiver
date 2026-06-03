import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { newId } from "@core/ids";
import { entityFilenameSlug } from "@core/pipeline/render";

export const NOTES_DIR = "notes";

/** Frontmatter summary of one topic note, fed to the notes-plan LLM call. */
export interface NoteIndexEntry {
  /** Filename inside notes/, e.g. "Bitcoin_Transactions.md". */
  file: string;
  title: string;
  topics: string[];
}

export interface Note {
  id: string;
  title: string;
  topics: string[];
  /** Conversation ids this note was distilled from (accumulated on merge). */
  sources: string[];
  created_at: string;
  updated_at: string;
  /** Markdown body (no frontmatter). */
  body: string;
}

export interface NoteWriteResult {
  absolutePath: string;
  /** Path relative to the vault root, e.g. "notes/Bitcoin_Transactions.md". */
  relativePath: string;
  file: string;
}

/**
 * Filesystem-backed store for distilled topic notes under `vault/notes/`.
 * No DB table: the vault is the index — `list()` scans frontmatter so the
 * notes-plan LLM call can decide create-vs-merge against what exists.
 */
export class NotesRepository {
  constructor(private readonly vaultPath: string) {}

  private get dir(): string {
    return join(resolve(this.vaultPath), NOTES_DIR);
  }

  fileForTitle(title: string): string {
    return `${entityFilenameSlug(title)}.md`;
  }

  async list(): Promise<NoteIndexEntry[]> {
    if (!existsSync(this.dir)) {
      return [];
    }
    const out: NoteIndexEntry[] = [];
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith(".md")) {
        continue;
      }
      try {
        const parsed = matter(await readFile(join(this.dir, file), "utf8"));
        out.push({
          file,
          title: String(parsed.data.title ?? file.replace(/\.md$/, "")),
          topics: (parsed.data.topics as string[] | undefined) ?? [],
        });
      } catch {
        // Unreadable note — skip rather than fail the whole pipeline.
      }
    }
    return out;
  }

  async read(file: string): Promise<Note | null> {
    const abs = join(this.dir, file);
    if (!existsSync(abs)) {
      return null;
    }
    const parsed = matter(await readFile(abs, "utf8"));
    return {
      id: String(parsed.data.id ?? ""),
      title: String(parsed.data.title ?? file.replace(/\.md$/, "")),
      topics: (parsed.data.topics as string[] | undefined) ?? [],
      sources: (parsed.data.sources as string[] | undefined) ?? [],
      created_at: String(parsed.data.created_at ?? ""),
      updated_at: String(parsed.data.updated_at ?? ""),
      body: parsed.content.trim(),
    };
  }

  /**
   * Create or overwrite a note. Identity (id/created_at) and accumulated
   * sources survive merges: pass the prior note's values via `existing`.
   */
  async write(input: {
    title: string;
    topics: string[];
    body: string;
    sourceConversationId: string;
    /** Merge target — keeps id/created_at/sources and the on-disk filename. */
    existing?: { file: string; note: Note };
  }): Promise<NoteWriteResult> {
    const now = new Date().toISOString();
    const file = input.existing?.file ?? this.fileForTitle(input.title);
    const prior = input.existing?.note;
    const sources = [
      ...new Set([...(prior?.sources ?? []), input.sourceConversationId]),
    ];
    const topics = [...new Set([...(prior?.topics ?? []), ...input.topics])];
    const data: Record<string, unknown> = {
      id: prior?.id || newId(),
      title: input.title,
      topics,
      sources,
      created_at: prior?.created_at || now,
      updated_at: now,
    };
    await mkdir(this.dir, { recursive: true });
    const abs = join(this.dir, file);
    await writeFile(abs, matter.stringify(`${input.body.trim()}\n`, data), "utf8");
    return {
      absolutePath: abs,
      relativePath: join(NOTES_DIR, file),
      file,
    };
  }
}
