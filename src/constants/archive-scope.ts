export const ArchiveScope = {
  Full: "full",
  Answer: "answer",
} as const;

export type ArchiveScope = (typeof ArchiveScope)[keyof typeof ArchiveScope];
