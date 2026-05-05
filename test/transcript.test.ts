import { describe, expect, it } from "vitest";
import { parseTranscriptText } from "@core/transcript";

describe("parseTranscriptText", () => {
  it("parses Claude Code-style JSONL with nested message.content arrays", () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-02T14:22:00.000Z",
        cwd: "/repo/tada-wallet",
        git: { repo: "tada-wallet", branch: "main" },
        message: {
          role: "user",
          content: [{ type: "text", text: "Why is X stuck?" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-02T14:22:30.000Z",
        model: "claude-opus-4-7",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Replica lag." },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "echo hi" },
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseTranscriptText(jsonl);
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0]!.role).toBe("user");
    expect(parsed.messages[0]!.content).toMatch(/Why is X stuck/);
    expect(parsed.messages[1]!.role).toBe("assistant");
    expect(parsed.messages[1]!.content).toMatch(/Replica lag/);
    expect(parsed.messages[1]!.content).toMatch(/\[tool_use:Bash\]/);
    expect(parsed.cwd).toBe("/repo/tada-wallet");
    expect(parsed.model).toBe("claude-opus-4-7");
    expect(parsed.git?.branch).toBe("main");
    expect(parsed.startedAt).toBe("2026-05-02T14:22:00.000Z");
  });

  it("ignores blank lines and unparseable lines", () => {
    const jsonl = [
      "",
      "not json",
      JSON.stringify({ role: "user", content: "hi" }),
    ].join("\n");
    const parsed = parseTranscriptText(jsonl);
    expect(parsed.messages.length).toBe(1);
  });

  it("drops messages with empty content", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "" }),
      JSON.stringify({ role: "assistant", content: "ok" }),
    ].join("\n");
    const parsed = parseTranscriptText(jsonl);
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0]!.role).toBe("assistant");
  });
});
