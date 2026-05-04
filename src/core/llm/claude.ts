import Anthropic from "@anthropic-ai/sdk";
import type { LLMCompleteOptions, LLMProvider } from "@core/llm/provider";

export interface ClaudeProviderOptions {
  apiKey: string;
  model: string;
  /** Default max_tokens when caller omits one. */
  defaultMaxTokens?: number;
}

/**
 * Claude API provider via the official SDK. Treats `complete` as a single-turn
 * messages.create call: one user message in, joined text blocks out.
 */
export class ClaudeProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly defaultMaxTokens: number;

  constructor(opts: ClaudeProviderOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async complete(opts: LLMCompleteOptions): Promise<string> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: opts.maxTokens ?? this.defaultMaxTokens,
      messages: [{ role: "user", content: opts.prompt }],
    };
    if (opts.system !== undefined) {
      params.system = opts.system;
    }
    // `temperature` is intentionally not forwarded — the SDK type marks it
    // deprecated, and Stage 2 prompts are deterministic enough without it.
    const response = await this.client.messages.create(params);
    const out: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        out.push(block.text);
      }
    }
    if (out.length === 0) {
      throw new Error("Claude returned no text content");
    }
    return out.join("\n");
  }
}
