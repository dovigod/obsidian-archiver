export const LLMProvider = {
  Claude: "claude",
  OpenAI: "openai",
  Local: "local",
} as const;

export type LLMProvider = (typeof LLMProvider)[keyof typeof LLMProvider];
