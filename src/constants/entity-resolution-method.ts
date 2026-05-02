export const EntityResolutionMethod = {
  Fuzzy: "fuzzy",
  LLM: "llm",
  Hybrid: "hybrid",
} as const;

export type EntityResolutionMethod =
  (typeof EntityResolutionMethod)[keyof typeof EntityResolutionMethod];
