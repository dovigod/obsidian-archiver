import { Role } from "@constants/role";
import type { Message } from "@core/schema";
import { flattenContent, type ParsedTranscript } from "@core/transcript/types";

/**
 * Parses the official ChatGPT data export (`conversations.json`). The export
 * is a JSON array; each element is one conversation with:
 *
 * - `title`              — conversation title
 * - `mapping`            — `{ [nodeId]: { id, parent, children, message? } }`
 *                          a tree of messages; forks may exist
 * - `current_node`       — id of the leaf of the user-selected branch
 * - `create_time`        — epoch seconds (float)
 * - `default_model_slug` — e.g. "gpt-4o"
 *
 * We walk `current_node` → `parent` recursively to get the canonical chain
 * (skipping any forked branches the user abandoned).
 */
interface ChatGPTMessageNode {
  id: string;
  parent?: string | null;
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: {
      content_type?: string;
      parts?: unknown[];
    };
  } | null;
}

interface ChatGPTConversation {
  title?: string;
  mapping?: Record<string, ChatGPTMessageNode>;
  current_node?: string;
  create_time?: number;
  default_model_slug?: string;
}

function roleFromAuthor(author: string | undefined): Role | null {
  if (!author) {
    return null;
  }
  const norm = author.toLowerCase();
  if (norm === "user") {return Role.User;}
  if (norm === "assistant") {return Role.Assistant;}
  if (norm === "system" || norm === "tool") {return Role.System;}
  return null;
}

function isoFromCreateTime(t: number | null | undefined): string | undefined {
  if (typeof t !== "number" || !Number.isFinite(t)) {
    return undefined;
  }
  return new Date(t * 1000).toISOString();
}

function walkCanonicalChain(
  mapping: Record<string, ChatGPTMessageNode>,
  leaf: string,
): ChatGPTMessageNode[] {
  const chain: ChatGPTMessageNode[] = [];
  let cursor: string | undefined = leaf;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: ChatGPTMessageNode | undefined = mapping[cursor];
    if (!node) {
      break;
    }
    chain.push(node);
    cursor = node.parent ?? undefined;
  }
  return chain.reverse();
}

function conversationToTranscript(
  conv: ChatGPTConversation,
): ParsedTranscript {
  const mapping = conv.mapping ?? {};
  const leaf = conv.current_node;
  let nodes: ChatGPTMessageNode[];
  if (leaf && mapping[leaf]) {
    nodes = walkCanonicalChain(mapping, leaf);
  } else {
    // No `current_node` (older exports) — fall back to insertion order.
    nodes = Object.values(mapping);
  }

  const messages: Message[] = [];
  let startedAt: string | undefined = isoFromCreateTime(conv.create_time);

  for (const node of nodes) {
    const msg = node.message;
    if (!msg) {continue;}
    const role = roleFromAuthor(msg.author?.role);
    if (!role) {continue;}
    const parts = msg.content?.parts ?? [];
    const content = flattenContent(parts).trim();
    if (!content) {continue;}
    const ts = isoFromCreateTime(msg.create_time);
    messages.push({
      role,
      content,
      ...(ts ? { timestamp: ts } : {}),
    });
    if (ts && (!startedAt || ts < startedAt)) {
      startedAt = ts;
    }
  }

  const out: ParsedTranscript = {
    messages,
    ...(conv.default_model_slug ? { model: conv.default_model_slug } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(conv.title ? { title: conv.title } : {}),
  };
  return out;
}

/** Parse a ChatGPT `conversations.json` export. Yields one transcript per chat. */
export function parseChatGPTText(text: string): ParsedTranscript[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  // Handle both shapes: array (bulk export) and a single conversation object
  const list: ChatGPTConversation[] = Array.isArray(parsed)
    ? (parsed as ChatGPTConversation[])
    : [parsed as ChatGPTConversation];

  return list
    .map(conversationToTranscript)
    .filter((t) => t.messages.length > 0);
}
