export const PageUpdateStrategy = {
  Append: "append",
  LLMRewrite: "llm_rewrite",
  Hybrid: "hybrid",
} as const;

export type PageUpdateStrategy =
  (typeof PageUpdateStrategy)[keyof typeof PageUpdateStrategy];
