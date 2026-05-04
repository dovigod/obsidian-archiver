import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import {
  type ClassifiedEntity,
  conversationToText,
} from "@core/pipeline/classify";
import type { EntityPage } from "@core/repository/knowledge";
import type { Conversation } from "@core/schema";

// Approximate token budget for prompt input. ~4 chars/token, target 80k tokens.
const TOKEN_BUDGET_CHARS = 80_000 * 4;

export interface SynthesizeArgs {
  entityName: string;
  candidate: ClassifiedEntity;
  existing: EntityPage | null;
  conversation: Conversation;
}

export async function synthesizeEntityBody(
  llm: LLMProvider,
  args: SynthesizeArgs,
): Promise<string> {
  const tpl = await loadPrompt("synthesize");
  const obsidianRef = await loadPrompt("obsidian-markdown");

  const convText = conversationToText(args.conversation);
  let existingBody = args.existing?.body ?? "";
  if (existingBody.length + convText.length > TOKEN_BUDGET_CHARS) {
    existingBody = await summarizeForBudget(
      llm,
      existingBody,
      Math.max(1024, TOKEN_BUDGET_CHARS - convText.length),
    );
  }

  const prompt = render(tpl, {
    obsidian_markdown: obsidianRef,
    entity_name: args.entityName,
    existing: existingBody,
    summary: args.candidate.summary,
    conversation: convText,
  });
  const text = await llm.complete({ prompt, maxTokens: 8192 });
  return text.trim();
}

async function summarizeForBudget(
  llm: LLMProvider,
  body: string,
  targetChars: number,
): Promise<string> {
  if (body.length <= targetChars) {
    return body;
  }
  const text = await llm.complete({
    prompt: `Summarize the following Obsidian markdown body into approximately ${Math.floor(
      targetChars / 4,
    )} tokens, preserving section headings (## ...) and key facts. Output only markdown:\n\n${body}`,
    maxTokens: Math.min(8192, Math.max(512, Math.floor(targetChars / 4))),
  });
  return text.trim();
}
