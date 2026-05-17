import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Source } from "@constants/source";
import type { ArchiveInput } from "@core/schema";
import { parseChatGPTText } from "@core/transcript/chatgpt";
import { parseClaudeCodeText } from "@core/transcript/claude-code";
import { parseGeminiText } from "@core/transcript/gemini";
import type { ExtraInputFields, ParsedTranscript } from "@core/transcript/types";

export type TranscriptSource = "claude-code" | "chatgpt" | "gemini";

export interface ParseTranscriptOptions {
  /** When omitted, the router sniffs by filename + content. */
  source?: TranscriptSource;
}

/** Map a `TranscriptSource` to the canonical archive `source` enum. */
export function transcriptSourceToArchiveSource(
  src: TranscriptSource,
): Source {
  if (src === "chatgpt") {return Source.OpenAI;}
  if (src === "gemini") {return Source.Gemini;}
  return Source.ClaudeCode;
}

function sniffSource(path: string, text: string): TranscriptSource {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".jsonl")) {return "claude-code";}
  if (name === "conversations.json") {return "chatgpt";}
  if (name === "myactivity.json") {return "gemini";}

  const trimmed = text.trim();
  if (!trimmed) {return "claude-code";}
  if (trimmed.startsWith("[")) {
    if (trimmed.includes('"mapping"')) {return "chatgpt";}
    if (
      trimmed.includes('"messages"') ||
      trimmed.includes('"Gemini') ||
      trimmed.includes('"role":"model"') ||
      trimmed.includes('"role": "model"')
    ) {
      return "gemini";
    }
  }
  return "claude-code";
}

/**
 * Parse a transcript file and yield one ParsedTranscript per conversation.
 * For JSONL/Claude Code, always a single transcript; for ChatGPT/Gemini bulk
 * exports, one per chat thread.
 */
export async function parseTranscriptFromPath(
  path: string,
  options: ParseTranscriptOptions = {},
): Promise<ParsedTranscript[]> {
  const text = await readFile(path, "utf8");
  const source = options.source ?? sniffSource(path, text);

  if (source === "chatgpt") {
    return parseChatGPTText(text);
  }
  if (source === "gemini") {
    return parseGeminiText(text);
  }
  const parsed = parseClaudeCodeText(text);
  return parsed.messages.length > 0 ? [parsed] : [];
}

export interface ParsedToArchiveOptions {
  source: TranscriptSource;
  extras?: ExtraInputFields;
}

/** Multi-source variant: explicit source, used by the new backfill pipeline. */
export function parsedToArchiveInput(
  parsed: ParsedTranscript,
  options: ParsedToArchiveOptions,
): ArchiveInput {
  const archiveSource = transcriptSourceToArchiveSource(options.source);
  const extras = options.extras ?? {};
  const out: ArchiveInput = {
    source: archiveSource,
    messages: parsed.messages,
  };
  if (parsed.model) {out.model = parsed.model;}
  if (parsed.startedAt) {out.created_at = parsed.startedAt;}
  if (parsed.cwd) {out.cwd = parsed.cwd;}
  if (parsed.git) {out.git = parsed.git;}
  if (extras.project) {out.project = extras.project;}
  if (extras.tags) {out.tags = extras.tags;}
  if (extras.topics) {out.topics = extras.topics;}
  if (extras.conversation_type) {out.conversation_type = extras.conversation_type;}
  return out;
}

// ---- Back-compat shims (Claude Code only) --------------------------------

export { parseClaudeCodeText as parseTranscriptText };

/** Back-compat: assume Claude Code source. New callers use `parseTranscriptFromPath`. */
export async function parseTranscriptFile(
  path: string,
): Promise<ParsedTranscript> {
  const text = await readFile(path, "utf8");
  return parseClaudeCodeText(text);
}

/** Back-compat: Claude Code-only convenience used by the existing CLI command. */
export function transcriptToArchiveInput(
  parsed: ParsedTranscript,
  extras: ExtraInputFields = {},
): ArchiveInput {
  return parsedToArchiveInput(parsed, { source: "claude-code", extras });
}

export type { ParsedTranscript } from "@core/transcript/types";
