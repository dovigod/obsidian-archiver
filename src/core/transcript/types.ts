import type { ArchiveInput, Message } from "@core/schema";

/**
 * Normalized output of any transcript parser. The router (`parseTranscript`)
 * dispatches by source/file shape and every parser produces this shape.
 */
export interface ParsedTranscript {
  messages: Message[];
  cwd?: string;
  model?: string;
  git?: { repo?: string; branch?: string; commit?: string };
  /** Earliest timestamp seen — used as conversation created_at when present. */
  startedAt?: string;
  /**
   * When a single transcript file contains multiple conversations (e.g. a
   * ChatGPT bulk export), the router yields one `ParsedTranscript` per
   * conversation. This optional field carries the per-conversation title /
   * thread name when the source format exposes one.
   */
  title?: string;
}

/** Flatten an arbitrary content payload (string | array | object) to a string. */
export function flattenContent(content: unknown): string {
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
    if (Array.isArray(obj.parts)) {
      // ChatGPT-style { parts: [...] }
      return flattenContent(obj.parts);
    }
    return "";
  }
  return String(content);
}

export type ExtraInputFields = Partial<
  Pick<ArchiveInput, "project" | "tags" | "topics" | "conversation_type">
>;
