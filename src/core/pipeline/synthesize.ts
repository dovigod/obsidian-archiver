import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import { conversationToText } from "@core/pipeline/extract";
import type { EntityPage } from "@core/repository/knowledge";
import type { Conversation } from "@core/schema";

// Approximate token budget for prompt input. ~4 chars/token, target 80k tokens.
const TOKEN_BUDGET_CHARS = 80_000 * 4;

export interface SynthesizeArgs {
  entityName: string;
  /** 1-2 sentence summary of what this conversation contributed. */
  summary: string;
  existing: EntityPage | null;
  conversation: Conversation;
}

/**
 * LLM-rewrite step: pass the existing page body + new conversation to the
 * synthesizer prompt and write back an integrated rewrite. Per design.md:
 * "Preserve existing facts unless contradicted." When the combined input
 * would blow the token budget, summarize the older body first.
 */
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
    summary: args.summary,
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
