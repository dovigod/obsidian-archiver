export const LLMProvider = {
  Claude: "claude",
  ClaudeCli: "claude-cli",
  OpenAI: "openai",
  Local: "local",
} as const;

export type LLMProvider = (typeof LLMProvider)[keyof typeof LLMProvider];
