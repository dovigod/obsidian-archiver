import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import { extractJson } from "@core/pipeline/json";
import type { Conversation } from "@core/schema";

export interface ClassifiedEntity {
  name: string;
  categories: string[];
  summary: string;
}

export function conversationToText(conv: Conversation): string {
  return conv.messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join("\n\n");
}

export async function classifyConversation(
  llm: LLMProvider,
  conv: Conversation,
): Promise<ClassifiedEntity[]> {
  const tpl = await loadPrompt("classify");
  const prompt = render(tpl, {
    conversation: conversationToText(conv),
  });
  const text = await llm.complete({ prompt, maxTokens: 4096 });
  const parsed = extractJson<{ entities?: ClassifiedEntity[] }>(text);
  const entities = parsed.entities ?? [];
  // Defensive: drop entries missing a name.
  return entities.filter((e) => e && typeof e.name === "string" && e.name.trim());
}
