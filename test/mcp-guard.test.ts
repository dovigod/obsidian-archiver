import { describe, expect, it } from "vitest";
import { detectTruncatedTranscript } from "@core/mcp";

describe("detectTruncatedTranscript", () => {
  it("rejects a payload that is only the triggering user message", () => {
    // Regression: ChatGPT's MCP connector sent exactly this shape — one user
    // turn containing the archive request itself, no assistant turns.
    const err = detectTruncatedTranscript([
      { role: "user", content: "이 대화내역 knowledge-hub에 저장해" },
    ]);
    expect(err).toMatch(/no assistant turn/);
    expect(err).toMatch(/COMPLETE history/);
  });

  it("rejects multiple user-only messages", () => {
    const err = detectTruncatedTranscript([
      { role: "user", content: "What is Redis?" },
      { role: "user", content: "archive this" },
    ]);
    expect(err).not.toBeNull();
  });

  it("accepts a real transcript with assistant turns", () => {
    const err = detectTruncatedTranscript([
      { role: "user", content: "What is Redis?" },
      { role: "assistant", content: "An in-memory key-value store." },
      { role: "user", content: "archive this" },
    ]);
    expect(err).toBeNull();
  });

  it("accepts system/tool turns as long as an assistant turn exists", () => {
    const err = detectTruncatedTranscript([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Run the tests." },
      { role: "tool", content: "86 passed" },
      { role: "assistant", content: "All 86 tests pass." },
    ]);
    expect(err).toBeNull();
  });
});
