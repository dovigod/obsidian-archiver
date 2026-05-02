export const CaptureMode = {
  Auto: "auto",
  Manual: "manual",
} as const;

export type CaptureMode = (typeof CaptureMode)[keyof typeof CaptureMode];
