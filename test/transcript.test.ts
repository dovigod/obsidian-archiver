import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
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
    assert.equal(parsed.messages.length, 2);
    assert.equal(parsed.messages[0]!.role, "user");
    assert.match(parsed.messages[0]!.content, /Why is X stuck/);
    assert.equal(parsed.messages[1]!.role, "assistant");
    assert.match(parsed.messages[1]!.content, /Replica lag/);
    assert.match(parsed.messages[1]!.content, /\[tool_use:Bash\]/);
    assert.equal(parsed.cwd, "/repo/tada-wallet");
    assert.equal(parsed.model, "claude-opus-4-7");
    assert.equal(parsed.git?.branch, "main");
    assert.equal(parsed.startedAt, "2026-05-02T14:22:00.000Z");
  });

  it("ignores blank lines and unparseable lines", () => {
    const jsonl = [
      "",
      "not json",
      JSON.stringify({ role: "user", content: "hi" }),
    ].join("\n");
    const parsed = parseTranscriptText(jsonl);
    assert.equal(parsed.messages.length, 1);
  });

  it("drops messages with empty content", () => {
    const jsonl = [
      JSON.stringify({ role: "user", content: "" }),
      JSON.stringify({ role: "assistant", content: "ok" }),
    ].join("\n");
    const parsed = parseTranscriptText(jsonl);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0]!.role, "assistant");
  });
});
