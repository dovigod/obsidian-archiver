import { Role } from "@constants/role";
import type { Message } from "@core/schema";
import type { ParsedTranscript } from "@core/transcript/types";

/**
 * Parses Google Takeout's Gemini export. Two shapes seen in the wild:
 *
 * 1. **Activity log** (Takeout default for "My Activity"):
 *    ```
 *    [
 *      { "title": "Said 'hello'", "subtitles": [...], "time": "...", ... },
 *      { "title": "Gemini responded ...", "time": "...", ... }
 *    ]
 *    ```
 *    User-issued prompts have title starting with `Said`/`Asked`; the
 *    immediately following entry is the model response.
 *
 * 2. **Conversation export** (newer JSON-based Gemini export):
 *    ```
 *    [{
 *      "title": "...",
 *      "messages": [
 *        { "role": "user", "content": "...", "create_time": "..." },
 *        { "role": "model", "content": "...", "create_time": "..." }
 *      ]
 *    }]
 *    ```
 *
 * Both yield a `ParsedTranscript[]` (one per conversation; shape 1 collapses
 * the whole activity log into a single transcript).
 */

interface ActivityRow {
  title?: string;
  subtitles?: { name?: string }[];
  time?: string;
  products?: string[];
}

interface ConversationShape {
  title?: string;
  create_time?: string;
  model?: string;
  messages?: GeminiMessage[];
}

interface GeminiMessage {
  role?: string;
  content?: string;
  create_time?: string;
}

function isActivityRow(value: unknown): value is ActivityRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "title" in (value as Record<string, unknown>) &&
    typeof (value as Record<string, unknown>).title === "string"
  );
}

function isConversationShape(value: unknown): value is ConversationShape {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const messages = (value as Record<string, unknown>).messages;
  return Array.isArray(messages);
}

function roleFromGemini(role: string | undefined): Role | null {
  if (!role) {return null;}
  const norm = role.toLowerCase();
  if (norm === "user" || norm === "human") {return Role.User;}
  if (norm === "model" || norm === "assistant" || norm === "gemini") {
    return Role.Assistant;
  }
  if (norm === "system") {return Role.System;}
  return null;
}

function parseConversationShape(conv: ConversationShape): ParsedTranscript {
  const messages: Message[] = [];
  let startedAt: string | undefined;
  for (const m of conv.messages ?? []) {
    const role = roleFromGemini(m.role);
    if (!role) {continue;}
    const content = (m.content ?? "").trim();
    if (!content) {continue;}
    messages.push({
      role,
      content,
      ...(m.create_time ? { timestamp: m.create_time } : {}),
    });
    if (m.create_time && (!startedAt || m.create_time < startedAt)) {
      startedAt = m.create_time;
    }
  }
  return {
    messages,
    ...(conv.model ? { model: conv.model } : {}),
    ...(startedAt
      ? { startedAt }
      : conv.create_time
        ? { startedAt: conv.create_time }
        : {}),
    ...(conv.title ? { title: conv.title } : {}),
  };
}

function parseActivityLog(rows: ActivityRow[]): ParsedTranscript {
  const messages: Message[] = [];
  let startedAt: string | undefined;

  for (const row of rows) {
    const title = (row.title ?? "").trim();
    if (!title) {continue;}
    // User actions start with verbs like "Said", "Asked", "Prompted"
    const userPrefix = /^(Said|Asked|Prompted|Searched for)\s+/i;
    const modelPrefix = /^Gemini\s+/i;
    let role: Role | null = null;
    let content = title;
    if (userPrefix.test(title)) {
      role = Role.User;
      content = title.replace(userPrefix, "").trim();
    } else if (modelPrefix.test(title)) {
      role = Role.Assistant;
      content = title.replace(modelPrefix, "").trim();
    }
    if (!role || !content) {continue;}
    messages.push({
      role,
      content,
      ...(row.time ? { timestamp: row.time } : {}),
    });
    if (row.time && (!startedAt || row.time < startedAt)) {
      startedAt = row.time;
    }
  }

  return {
    messages,
    ...(startedAt ? { startedAt } : {}),
  };
}

export function parseGeminiText(text: string): ParsedTranscript[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    if (isConversationShape(parsed)) {
      const t = parseConversationShape(parsed);
      return t.messages.length > 0 ? [t] : [];
    }
    return [];
  }

  // Heuristic: if any entry has `messages: [...]`, treat as conversation-shape
  if (parsed.some(isConversationShape)) {
    return parsed
      .filter(isConversationShape)
      .map(parseConversationShape)
      .filter((t) => t.messages.length > 0);
  }
  if (parsed.every(isActivityRow)) {
    const t = parseActivityLog(parsed);
    return t.messages.length > 0 ? [t] : [];
  }
  return [];
}
