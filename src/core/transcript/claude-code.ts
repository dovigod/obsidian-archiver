import { z } from "zod";
import { Role } from "@constants/role";
import { type Message, RoleSchema } from "@core/schema";
import { flattenContent, type ParsedTranscript } from "@core/transcript/types";

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

export function parseClaudeCodeText(text: string): ParsedTranscript {
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
