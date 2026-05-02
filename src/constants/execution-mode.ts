export const ExecutionMode = {
  Async: "async",
  Sync: "sync",
} as const;

export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];
