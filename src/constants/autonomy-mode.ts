export const AutonomyMode = {
  Auto: "auto",
  Proposal: "proposal",
  Hybrid: "hybrid",
} as const;

export type AutonomyMode = (typeof AutonomyMode)[keyof typeof AutonomyMode];
