import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import { extractJson } from "@core/pipeline/json";
import {
  type Conversation,
  type ExtractedEntity,
  ExtractOutputSchema,
} from "@core/schema";

export function conversationToText(conv: Conversation): string {
  return conv.messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");
}

/**
 * First step of the Stage 2 pipeline: pull distinct entity candidates from a
 * single conversation. Each candidate is later fed to the resolver +
 * classifier independently.
 *
 * Failure modes are recoverable: malformed JSON or empty entity list both
 * return `[]` so the pipeline keeps draining instead of crashing the worker.
 */
export async function extractEntities(
  llm: LLMProvider,
  conv: Conversation,
): Promise<ExtractedEntity[]> {
  const tpl = await loadPrompt("extract");
  const prompt = render(tpl, { conversation: conversationToText(conv) });
  const text = await llm.complete({ prompt, maxTokens: 4096 });

  let raw: unknown;
  try {
    raw = extractJson<unknown>(text);
  } catch {
    return [];
  }
  const parsed = ExtractOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.entities.filter((e) => e.name.trim().length > 0);
}
