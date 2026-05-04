import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import {
  type Conversation,
  ConversationSchema,
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

function formatMessages(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const header = ROLE_HEADERS[m.role];
      const tsLine = m.timestamp ? `<!-- ${m.timestamp} -->\n` : "";
      return `# ${header}\n${tsLine}\n${m.content.trim()}`;
    })
    .join("\n\n");
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

    const body = formatMessages(conv.messages);
    const content = matter.stringify(body, frontmatterFromConversation(conv));
    await writeFile(abs, content, "utf8");

    return { absolutePath: abs, relativePath: rel };
  }

  /** Reverse of writeConversation: parse the on-disk Markdown back into a Conversation. */
  async readConversation(relativePath: string): Promise<Conversation> {
    const abs = join(resolve(this.vaultPath), relativePath);
    const text = await readFile(abs, "utf8");
    const parsed = matter(text);
    const messages = parseMessagesBody(parsed.content);
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
    });
  }
}
