import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import {
  ArchiveScope,
  type Conversation,
  ConversationSchema,
  Fidelity,
  type Message,
} from "@core/schema";

export interface RawWriteResult {
  /** Absolute path to the written markdown file. */
  absolutePath: string;
  /** Path relative to the vault root. */
  relativePath: string;
}

const ROLE_HEADERS: Record<Message["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
};

const HEADER_TO_ROLE: Record<string, Message["role"]> = Object.entries(
  ROLE_HEADERS,
).reduce<Record<string, Message["role"]>>((acc, [role, header]) => {
  acc[header.toLowerCase()] = role as Message["role"];
  return acc;
}, {});

/**
 * Legacy message divider: `# User` / `# Assistant` H1 headings. Only used
 * when re-writing a conversation that still carries Template A fields —
 * the legacy parser depends on this exact shape. The format is LOSSY when
 * message content itself contains column-0 `#`/`##` headings, which is why
 * new writes use sentinel comments instead (see `formatSentinelMessages`).
 */
function formatMessages(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const header = ROLE_HEADERS[m.role];
      const tsLine = m.timestamp ? `<!-- ${m.timestamp} -->\n` : "";
      return `# ${header}\n${tsLine}\n${m.content.trim()}`;
    })
    .join("\n\n");
}

/**
 * Current message divider: an HTML-comment sentinel per message, followed by
 * the human-readable `# Role` heading. Obsidian hides the comment; the
 * parser splits ONLY on sentinels, so assistant content containing `#`/`##`
 * headings at column 0 round-trips losslessly (the old H1-divider format
 * swallowed everything after such a line — observed as topic notes built
 * from empty assistant bodies).
 */
const MSG_SENTINEL_RE =
  /^<!-- kh:msg (user|assistant|system|tool)(?: (\S+))? -->$/gm;

function formatSentinelMessages(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const ts = m.timestamp ? ` ${m.timestamp}` : "";
      return `<!-- kh:msg ${m.role}${ts} -->\n# ${ROLE_HEADERS[m.role]}\n\n${m.content.trim()}`;
    })
    .join("\n\n");
}

function parseSentinelMessages(body: string): Message[] {
  const out: Message[] = [];
  const matches = [...body.matchAll(MSG_SENTINEL_RE)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const role = match[1] as Message["role"];
    const timestamp = match[2];
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
    let chunk = body.slice(start, end).replace(/^\n+/, "");
    // Strip the readability heading we wrote right after the sentinel.
    const headingLine = `# ${ROLE_HEADERS[role]}`;
    if (chunk.startsWith(`${headingLine}\n`)) {
      chunk = chunk.slice(headingLine.length + 1);
    } else if (chunk === headingLine) {
      chunk = "";
    }
    const message: Message = { role, content: chunk.trim() };
    if (timestamp !== undefined) {
      message.timestamp = timestamp;
    }
    out.push(message);
  }
  return out;
}

/**
 * Template A — summary-first verbatim. Renders optional TL;DR / takeaways /
 * entities sections above the verbatim transcript. The transcript still uses
 * `# User` / `# Assistant` H1 dividers so `parseMessagesBody` (which splits
 * on `^# ` and ignores unknown headers) round-trips cleanly.
 */
function formatBody(conv: Conversation): string {
  const sections: string[] = [];
  if (conv.summary && conv.summary.trim().length > 0) {
    sections.push(`## TL;DR\n\n${conv.summary.trim()}`);
  }
  if (conv.takeaways && conv.takeaways.length > 0) {
    const bullets = conv.takeaways.map((t) => `- ${t.trim()}`).join("\n");
    sections.push(`## Key takeaways\n\n${bullets}`);
  }
  if (conv.entities && conv.entities.length > 0) {
    const bullets = conv.entities
      .map((e) => `- [[${e.trim()}]]`)
      .join("\n");
    sections.push(`## Entities\n\n${bullets}`);
  }
  const relatedQuestions = conv.related_questions ?? [];
  if (sections.length === 0 && relatedQuestions.length === 0) {
    // Verbatim-only (every new archive): sentinel dividers, lossless for
    // message content that itself contains markdown headings.
    return formatSentinelMessages(conv.messages);
  }
  // Legacy Template A re-write — keep the H1-divider shape its parser expects.
  const transcript = formatMessages(conv.messages);
  sections.push(`## Conversation\n\n${transcript}`);
  if (relatedQuestions.length > 0) {
    const bullets = relatedQuestions.map((q) => `- ${q.trim()}`).join("\n");
    sections.push(`## Related questions\n\n${bullets}`);
  }
  return sections.join("\n\n");
}

/**
 * Pull H2 sections (TL;DR / Key takeaways / Entities) out of a parsed body
 * so that `readConversation` can round-trip them back into Conversation fields.
 * Body is the content above the first `^# Role` H1 divider.
 */
function parseTemplateHeader(body: string): {
  summary?: string;
  takeaways?: string[];
  entities?: string[];
  transcriptStart: number;
} {
  // Find where the verbatim transcript begins — first line starting with `# `
  // whose header maps to a known role.
  const lines = body.split("\n");
  let transcriptLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("# ")) {
      const header = line.slice(2).trim().toLowerCase();
      if (HEADER_TO_ROLE[header]) {
        transcriptLineIdx = i;
        break;
      }
    }
  }
  if (transcriptLineIdx === -1) {
    return { transcriptStart: 0 };
  }

  const headerText = lines.slice(0, transcriptLineIdx).join("\n");
  if (!headerText.trim()) {
    return { transcriptStart: 0 };
  }

  const summary = extractH2Section(headerText, "TL;DR");
  const takeawaysRaw = extractH2Section(headerText, "Key takeaways");
  const entitiesRaw = extractH2Section(headerText, "Entities");

  // Compute byte offset where the transcript begins, so the caller can slice
  // and reuse the existing parser unchanged.
  const transcriptStart = lines.slice(0, transcriptLineIdx).join("\n").length +
    (transcriptLineIdx > 0 ? 1 : 0); // +1 for the newline before the H1

  const out: {
    summary?: string;
    takeaways?: string[];
    entities?: string[];
    transcriptStart: number;
  } = { transcriptStart };
  if (summary) {
    out.summary = summary;
  }
  if (takeawaysRaw) {
    out.takeaways = parseBulletList(takeawaysRaw);
  }
  if (entitiesRaw) {
    out.entities = parseBulletList(entitiesRaw).map((b) =>
      b.replace(/^\[\[(.+)\]\]$/, "$1").trim(),
    );
  }
  return out;
}

/**
 * Extract the body of an `## {heading}` H2 section. Section ends at the next
 * `^## ` or `^### ` boundary, OR end-of-string when the section is the last
 * in the document (JS regex has no `\Z` anchor, so we do this index-style
 * rather than with a single regex).
 */
function extractH2Section(text: string, heading: string): string | undefined {
  const marker = `## ${heading}`;
  let headingStart = -1;
  if (text.startsWith(marker)) {
    headingStart = 0;
  } else {
    const nl = text.indexOf(`\n${marker}`);
    if (nl !== -1) {
      headingStart = nl + 1;
    }
  }
  if (headingStart === -1) {
    return undefined;
  }
  // Skip the heading line, then any blank lines.
  const lineEnd = text.indexOf("\n", headingStart + marker.length);
  if (lineEnd === -1) {
    return undefined;
  }
  const contentStart = lineEnd + 1;
  const rest = text.slice(contentStart);
  const h2Idx = rest.search(/^## /m);
  const h3Idx = rest.search(/^### /m);
  let endIdx = rest.length;
  if (h2Idx !== -1) {endIdx = Math.min(endIdx, h2Idx);}
  if (h3Idx !== -1) {endIdx = Math.min(endIdx, h3Idx);}
  const body = rest.slice(0, endIdx).trim();
  return body.length > 0 ? body : undefined;
}

function parseBulletList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function parseMessagesBody(body: string): Message[] {
  const out: Message[] = [];
  // Each message section starts with a line "# Header" at column 0. Split,
  // discarding leading frontmatter slack and inter-section whitespace.
  const sections = body.split(/^# /m).filter((s) => s.trim().length > 0);
  for (const section of sections) {
    const newlineIdx = section.indexOf("\n");
    const header = (
      newlineIdx === -1 ? section : section.slice(0, newlineIdx)
    )
      .trim()
      .toLowerCase();
    const role = HEADER_TO_ROLE[header];
    if (!role) {
      continue;
    }
    let rest = newlineIdx === -1 ? "" : section.slice(newlineIdx + 1);
    // Clip the message body at the next ^## H2 marker so trailing template
    // sections appended AFTER the verbatim transcript (e.g. "## Related
    // questions") don't get swallowed into the final assistant message.
    const h2Cut = rest.search(/^## /m);
    if (h2Cut !== -1) {
      rest = rest.slice(0, h2Cut);
    }
    let timestamp: string | undefined;
    const tsMatch = rest.match(/^<!--\s*(\S+)\s*-->\s*\n/);
    if (tsMatch) {
      timestamp = tsMatch[1];
      rest = rest.slice(tsMatch[0].length);
    }
    const message: Message = { role, content: rest.trim() };
    if (timestamp !== undefined) {
      message.timestamp = timestamp;
    }
    out.push(message);
  }
  return out;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function frontmatterFromConversation(
  conv: Conversation,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: conv.id,
    source: conv.source,
    created_at: conv.created_at,
  };
  if (conv.model) {
    data.model = conv.model;
  }
  if (conv.cwd) {
    data.cwd = conv.cwd;
  }
  if (conv.project.length) {
    data.project = conv.project;
  }
  if (conv.topics.length) {
    data.topics = conv.topics;
  }
  if (conv.conversation_type.length) {
    data.conversation_type = conv.conversation_type;
  }
  if (conv.tags.length) {
    data.tags = conv.tags;
  }
  if (conv.git && Object.values(conv.git).some((v) => v !== undefined)) {
    data.git = conv.git;
  }
  if (conv.intent) {
    data.intent = conv.intent;
  }
  if (conv.partial) {
    data.partial = true;
  }
  if (conv.scope && conv.scope !== ArchiveScope.Full) {
    data.scope = conv.scope;
  }
  if (conv.fidelity && conv.fidelity !== Fidelity.Verbatim) {
    data.fidelity = conv.fidelity;
  }
  return data;
}

export class MarkdownVaultRepository {
  constructor(private readonly vaultPath: string) {}

  /** vault/raw/conversations/YYYY/MM/{id}.md */
  pathForConversation(conv: Conversation): { abs: string; rel: string } {
    const created = new Date(conv.created_at);
    const yyyy = created.getUTCFullYear().toString();
    const mm = pad2(created.getUTCMonth() + 1);
    const rel = join("raw", "conversations", yyyy, mm, `${conv.id}.md`);
    return { abs: join(resolve(this.vaultPath), rel), rel };
  }

  async writeConversation(conv: Conversation): Promise<RawWriteResult> {
    const { abs, rel } = this.pathForConversation(conv);
    await mkdir(dirname(abs), { recursive: true });

    const body = formatBody(conv);
    const content = matter.stringify(body, frontmatterFromConversation(conv));
    await writeFile(abs, content, "utf8");

    return { absolutePath: abs, relativePath: rel };
  }

  /** Reverse of writeConversation: parse the on-disk Markdown back into a Conversation. */
  async readConversation(relativePath: string): Promise<Conversation> {
    const abs = join(resolve(this.vaultPath), relativePath);
    const text = await readFile(abs, "utf8");
    const parsed = matter(text);
    // Sentinel files (current format) parse losslessly and never carry
    // template sections; everything else goes through the legacy parsers.
    MSG_SENTINEL_RE.lastIndex = 0;
    const isSentinel = MSG_SENTINEL_RE.test(parsed.content);
    MSG_SENTINEL_RE.lastIndex = 0;
    const header: ReturnType<typeof parseTemplateHeader> = isSentinel
      ? { transcriptStart: 0 }
      : parseTemplateHeader(parsed.content);
    const messages = isSentinel
      ? parseSentinelMessages(parsed.content)
      : parseMessagesBody(parsed.content);
    // `## Related questions` sits AFTER the verbatim transcript, so scan the
    // full body for it rather than the pre-transcript header slice.
    const relatedRaw = isSentinel
      ? undefined
      : extractH2Section(parsed.content, "Related questions");
    const relatedQuestions = relatedRaw ? parseBulletList(relatedRaw) : [];
    return ConversationSchema.parse({
      id: String(parsed.data.id ?? ""),
      source: parsed.data.source,
      model: parsed.data.model,
      created_at: parsed.data.created_at,
      cwd: parsed.data.cwd,
      project: (parsed.data.project as string[] | undefined) ?? [],
      topics: (parsed.data.topics as string[] | undefined) ?? [],
      conversation_type:
        (parsed.data.conversation_type as string[] | undefined) ?? [],
      tags: (parsed.data.tags as string[] | undefined) ?? [],
      git: parsed.data.git,
      messages,
      ...(parsed.data.intent ? { intent: String(parsed.data.intent) } : {}),
      ...(parsed.data.partial ? { partial: true } : {}),
      ...(parsed.data.scope === ArchiveScope.Answer
        ? { scope: ArchiveScope.Answer }
        : {}),
      ...(parsed.data.fidelity === Fidelity.Summarized
        ? { fidelity: Fidelity.Summarized }
        : {}),
      ...(header.summary ? { summary: header.summary } : {}),
      ...(header.takeaways && header.takeaways.length
        ? { takeaways: header.takeaways }
        : {}),
      ...(header.entities && header.entities.length
        ? { entities: header.entities }
        : {}),
      ...(relatedQuestions.length
        ? { related_questions: relatedQuestions }
        : {}),
    });
  }
}
