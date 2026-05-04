import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";

export interface ConversationLink {
  id: string;
  /** Vault-relative path without the .md extension. */
  path: string;
  /** Optional human-readable label for the wikilink. */
  label?: string;
}

export interface EntityPage {
  id: string;
  name: string;
  categories: string[];
  sources: ConversationLink[];
  updated_at: string;
  /** Markdown body without frontmatter, without leading H1, without ## Sources. */
  body: string;
}

export interface EntityWriteResult {
  absolutePath: string;
  relativePath: string;
}

export interface EntitySummary {
  name: string;
  categories: string[];
}

/**
 * Replace anything unsafe for vault filenames. Entity names are kept verbatim
 * where possible so wikilinks `[[Redis]]` resolve to `Redis.md`.
 */
export function entityFilenameSlug(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .trim();
}

function renderSourcesSection(sources: readonly ConversationLink[]): string {
  if (sources.length === 0) {
    return "## Sources\n";
  }
  const lines = sources
    .map((s) => `- [[${s.path}|${s.label ?? s.id}]]`)
    .join("\n");
  return `## Sources\n\n${lines}\n`;
}

function stripLeadingH1(body: string, name: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") {
    i++;
  }
  if (i < lines.length && lines[i]!.trim() === `# ${name}`) {
    i++;
    while (i < lines.length && lines[i]!.trim() === "") {
      i++;
    }
  }
  return lines.slice(i).join("\n");
}

function stripSourcesSection(body: string): string {
  const idx = body.search(/^## Sources\b/m);
  if (idx === -1) {
    return body;
  }
  return body.slice(0, idx).replace(/\s+$/, "") + "\n";
}

export class KnowledgeRepository {
  constructor(private readonly vaultPath: string) {}

  private dir(): string {
    return join(resolve(this.vaultPath), "knowledge");
  }

  pathForEntity(name: string): { abs: string; rel: string } {
    const file = `${entityFilenameSlug(name)}.md`;
    return { abs: join(this.dir(), file), rel: join("knowledge", file) };
  }

  async listEntities(): Promise<EntitySummary[]> {
    const dir = this.dir();
    if (!existsSync(dir)) {
      return [];
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    const out: EntitySummary[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      const parsed = matter(text);
      const name =
        (parsed.data.name as string | undefined) ?? file.replace(/\.md$/, "");
      const categories =
        (parsed.data.categories as string[] | undefined) ?? [];
      out.push({ name, categories });
    }
    return out;
  }

  async readEntity(name: string): Promise<EntityPage | null> {
    const { abs } = this.pathForEntity(name);
    if (!existsSync(abs)) {
      return null;
    }
    const text = await readFile(abs, "utf8");
    const parsed = matter(text);
    const canonicalName = String(parsed.data.name ?? name);
    let body = parsed.content;
    body = stripLeadingH1(body, canonicalName);
    body = stripSourcesSection(body);
    return {
      id: String(parsed.data.id ?? ""),
      name: canonicalName,
      categories: (parsed.data.categories as string[] | undefined) ?? [],
      sources:
        (parsed.data.sources as ConversationLink[] | undefined) ?? [],
      updated_at: String(parsed.data.updated_at ?? ""),
      body: body.trim(),
    };
  }

  async writeEntity(page: EntityPage): Promise<EntityWriteResult> {
    const { abs, rel } = this.pathForEntity(page.name);
    await mkdir(dirname(abs), { recursive: true });
    const data: Record<string, unknown> = {
      id: page.id,
      name: page.name,
      categories: page.categories,
      sources: page.sources,
      updated_at: page.updated_at,
    };
    const sources = renderSourcesSection(page.sources);
    const body = page.body.trim();
    const composed = body
      ? `# ${page.name}\n\n${body}\n\n${sources}`
      : `# ${page.name}\n\n${sources}`;
    const text = matter.stringify(composed, data);
    await writeFile(abs, text, "utf8");
    return { absolutePath: abs, relativePath: rel };
  }
}
