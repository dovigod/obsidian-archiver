export const Role = {
  User: "user",
  Assistant: "assistant",
  System: "system",
  Tool: "tool",
} as const;

export type Role = (typeof Role)[keyof typeof Role];
