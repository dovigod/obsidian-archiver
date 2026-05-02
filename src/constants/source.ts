export const Source = {
  ClaudeCode: "claude-code",
  ClaudeApi: "claude-api",
  ClaudeWeb: "claude-web",
  OpenAI: "openai",
  Gemini: "gemini",
  Manual: "manual",
} as const;

export type Source = (typeof Source)[keyof typeof Source];
