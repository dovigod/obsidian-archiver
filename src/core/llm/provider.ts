export interface LLMCompleteOptions {
  /** Optional system prompt (Claude's `system` field). */
  system?: string;
  /** User-turn content. */
  prompt: string;
  /** Max output tokens. Provider supplies a default. */
  maxTokens?: number;
  /** 0..1; defaults to provider default. */
  temperature?: number;
}

/**
 * Minimal completion-style interface used by the Stage 2 pipeline.
 *
 * Both classify and resolve return JSON inside a text response; synthesize
 * returns markdown. The pipeline parses content; the provider stays
 * format-agnostic.
 */
export interface LLMProvider {
  complete(opts: LLMCompleteOptions): Promise<string>;
}
