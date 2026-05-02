import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Role } from "@constants/role";
import { Source } from "@constants/source";
import {
  type ArchiveInput,
  type Message,
  RoleSchema,
} from "@core/schema";

/**
 * Loose schema for a single Claude Code JSONL line. The on-disk format has
 * shifted across releases; we accept any shape that has a recognizable role
 * + content payload and ignore the rest.
 */
const RawLineSchema = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    git: z
      .object({
        repo: z.string().optional(),
        branch: z.string().optional(),
        commit: z.string().optional(),
      })
      .partial()
      .optional(),
    model: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.unknown().optional(),
      })
      .partial()
      .optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

type RawLine = z.infer<typeof RawLineSchema>;

function flattenContent(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => flattenContent(part))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.content === "string") {
      return obj.content;
    }
    if (Array.isArray(obj.content)) {
      return flattenContent(obj.content);
    }
    if (obj.type === "tool_use") {
      const name = typeof obj.name === "string" ? obj.name : "tool";
      const input = obj.input ?? {};
      return `[tool_use:${name}] ${JSON.stringify(input)}`;
    }
    if (obj.type === "tool_result") {
      return `[tool_result] ${flattenContent(obj.content)}`;
    }
    return "";
  }
  return String(content);
}

function inferRole(line: RawLine): Role | null {
  const candidate =
    line.message?.role ??
    line.role ??
    (line.type === Role.System ? Role.System : "");
  if (!candidate) {
    return null;
  }
  const norm = candidate.toLowerCase();
  if (norm === "human") {
    return Role.User;
  }
  const parsed = RoleSchema.safeParse(norm);
  return parsed.success ? parsed.data : null;
}

function lineToMessage(line: RawLine): Message | null {
  const role = inferRole(line);
  if (!role) {
    return null;
  }
  const rawContent = line.message?.content ?? line.content;
  const content = flattenContent(rawContent).trim();
  if (!content) {
    return null;
  }
  return {
    role,
    content,
    timestamp: line.timestamp,
  };
}

export interface ParsedTranscript {
  messages: Message[];
  cwd?: string;
  model?: string;
  git?: { repo?: string; branch?: string; commit?: string };
  /** Earliest timestamp seen — used as conversation created_at when present. */
  startedAt?: string;
}

export function parseTranscriptText(text: string): ParsedTranscript {
  const messages: Message[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  let git: { repo?: string; branch?: string; commit?: string } | undefined;
  let startedAt: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const lineResult = RawLineSchema.safeParse(parsedJson);
    if (!lineResult.success) {
      continue;
    }
    const line = lineResult.data;

    if (!cwd && line.cwd) {
      cwd = line.cwd;
    }
    if (!model && line.model) {
      model = line.model;
    }
    if (!git && line.git) {
      git = line.git;
    }
    if (line.timestamp && (!startedAt || line.timestamp < startedAt)) {
      startedAt = line.timestamp;
    }

    const msg = lineToMessage(line);
    if (msg) {
      messages.push(msg);
    }
  }

  return { messages, cwd, model, git, startedAt };
}

export async function parseTranscriptFile(
  path: string,
): Promise<ParsedTranscript> {
  const text = await readFile(path, "utf8");
  return parseTranscriptText(text);
}

export function transcriptToArchiveInput(
  parsed: ParsedTranscript,
  extras: Partial<
    Pick<ArchiveInput, "project" | "tags" | "topics" | "conversation_type">
  > = {},
): ArchiveInput {
  return {
    source: Source.ClaudeCode,
    model: parsed.model,
    created_at: parsed.startedAt,
    cwd: parsed.cwd,
    git: parsed.git,
    messages: parsed.messages,
    project: extras.project,
    tags: extras.tags,
    topics: extras.topics,
    conversation_type: extras.conversation_type,
  };
}
