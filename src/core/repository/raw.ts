import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import type { Conversation, Message } from "@core/schema";

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

function formatMessages(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const header = ROLE_HEADERS[m.role];
      const tsLine = m.timestamp ? `<!-- ${m.timestamp} -->\n` : "";
      return `# ${header}\n${tsLine}\n${m.content.trim()}`;
    })
    .join("\n\n");
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
    const rel = join(
      "raw",
      "conversations",
      yyyy,
      mm,
      `${conv.id}.md`,
    );
    return { abs: join(resolve(this.vaultPath), rel), rel };
  }

  async writeConversation(conv: Conversation): Promise<RawWriteResult> {
    const { abs, rel } = this.pathForConversation(conv);
    await mkdir(dirname(abs), { recursive: true });

    const body = formatMessages(conv.messages);
    const content = matter.stringify(body, frontmatterFromConversation(conv));
    await writeFile(abs, content, "utf8");

    return {
      absolutePath: abs,
      relativePath: rel,
    };
  }
}
