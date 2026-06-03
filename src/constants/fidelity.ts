export const Fidelity = {
  /** Transcript is the original text, turn for turn. */
  Verbatim: "verbatim",
  /**
   * Transcript content was compressed by the capturing model (observed:
   * ChatGPT never emits its own answers verbatim into tool arguments).
   * The lossless original lives in the source platform's data export.
   */
  Summarized: "summarized",
} as const;

export type Fidelity = (typeof Fidelity)[keyof typeof Fidelity];
