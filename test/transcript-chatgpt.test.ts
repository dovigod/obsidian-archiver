import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChatGPTText } from "@core/transcript/chatgpt";
import { parseTranscriptFromPath } from "@core/transcript";
import { testTmpDir } from "./helpers";

const TWO_CONVERSATIONS = [
  {
    title: "Talking about Redis",
    create_time: 1_700_000_000,
    default_model_slug: "gpt-4o",
    current_node: "leaf-a",
    mapping: {
      root: {
        id: "root",
        parent: null,
        message: null,
      },
      "node-1": {
        id: "node-1",
        parent: "root",
        message: {
          author: { role: "user" },
          create_time: 1_700_000_001,
          content: {
            content_type: "text",
            parts: ["What is Redis?"],
          },
        },
      },
      "fork-abandoned": {
        id: "fork-abandoned",
        parent: "node-1",
        message: {
          author: { role: "assistant" },
          create_time: 1_700_000_002,
          content: {
            content_type: "text",
            parts: ["A forked answer the user abandoned"],
          },
        },
      },
      "leaf-a": {
        id: "leaf-a",
        parent: "node-1",
        message: {
          author: { role: "assistant" },
          create_time: 1_700_000_003,
          content: {
            content_type: "text",
            parts: ["Redis is an in-memory key-value store."],
          },
        },
      },
    },
  },
  {
    title: "Empty thread",
    mapping: {},
  },
];

describe("parseChatGPTText", () => {
  it("walks current_node back through mapping and ignores abandoned forks", () => {
    const parsed = parseChatGPTText(JSON.stringify(TWO_CONVERSATIONS));
    expect(parsed.length).toBe(1);
    const first = parsed[0]!;
    expect(first.title).toBe("Talking about Redis");
    expect(first.messages.length).toBe(2);
    expect(first.messages[0]!.role).toBe("user");
    expect(first.messages[0]!.content).toMatch(/What is Redis/);
    expect(first.messages[1]!.role).toBe("assistant");
    expect(first.messages[1]!.content).toMatch(/in-memory key-value store/);
    expect(first.model).toBe("gpt-4o");
    expect(first.startedAt).toBe(
      new Date(1_700_000_000 * 1000).toISOString(),
    );
  });

  it("returns [] on malformed JSON", () => {
    expect(parseChatGPTText("not json")).toEqual([]);
  });

  it("auto-detects chatgpt by content via parseTranscriptFromPath", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "chatgpt-sniff-"));
    const file = join(dir, "conversations.json");
    writeFileSync(file, JSON.stringify(TWO_CONVERSATIONS));
    const parsed = await parseTranscriptFromPath(file);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.messages.length).toBe(2);
  });
});
