import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import { conversationToText } from "@core/pipeline/extract";
import type { Conversation } from "@core/schema";

export interface RewriteArgs {
  name: string;
  existingBody: string;
  conversation: Conversation;
}

/**
 * LLM-rewrite an entity body: pass existing body + new conversation excerpt
 * and write back an integrated rewrite.
 *
 * "Preserve existing facts unless contradicted" framing in the prompt;
 * token-budget cap is set generously here, the prompt's own length caps
 * keep the actual body in check.
 */
export async function rewriteEntityBody(
  llm: LLMProvider,
  args: RewriteArgs,
): Promise<string> {
  const tpl = await loadPrompt("rewrite");
  const prompt = render(tpl, {
    name: args.name,
    existing_body: args.existingBody || "(no existing body)",
    conversation_excerpt: conversationToText(args.conversation),
  });
  const text = await llm.complete({ prompt, maxTokens: 4096 });
  return text.trim();
}
