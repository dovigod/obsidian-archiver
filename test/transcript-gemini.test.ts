import { describe, expect, it } from "vitest";
import { parseGeminiText } from "@core/transcript/gemini";

describe("parseGeminiText", () => {
  it("parses the conversation-shape export", () => {
    const json = JSON.stringify([
      {
        title: "About Redis",
        model: "gemini-1.5-pro",
        create_time: "2026-05-02T14:22:00.000Z",
        messages: [
          {
            role: "user",
            content: "What is Redis?",
            create_time: "2026-05-02T14:22:00.000Z",
          },
          {
            role: "model",
            content: "Redis is an in-memory KV store.",
            create_time: "2026-05-02T14:22:30.000Z",
          },
        ],
      },
    ]);
    const parsed = parseGeminiText(json);
    expect(parsed.length).toBe(1);
    const first = parsed[0]!;
    expect(first.messages.length).toBe(2);
    expect(first.messages[0]!.role).toBe("user");
    expect(first.messages[1]!.role).toBe("assistant");
    expect(first.title).toBe("About Redis");
    expect(first.model).toBe("gemini-1.5-pro");
    expect(first.startedAt).toBe("2026-05-02T14:22:00.000Z");
  });

  it("parses the Takeout activity-log shape", () => {
    const json = JSON.stringify([
      {
        title: "Asked How does replica lag work?",
        time: "2026-04-01T10:00:00.000Z",
        products: ["Gemini"],
      },
      {
        title: "Gemini Replica lag is the delay...",
        time: "2026-04-01T10:00:30.000Z",
        products: ["Gemini"],
      },
    ]);
    const parsed = parseGeminiText(json);
    expect(parsed.length).toBe(1);
    const first = parsed[0]!;
    expect(first.messages.length).toBe(2);
    expect(first.messages[0]!.role).toBe("user");
    expect(first.messages[0]!.content).toMatch(/How does replica lag work/);
    expect(first.messages[1]!.role).toBe("assistant");
    expect(first.messages[1]!.content).toMatch(/Replica lag is the delay/);
    expect(first.startedAt).toBe("2026-04-01T10:00:00.000Z");
  });

  it("returns [] on malformed JSON", () => {
    expect(parseGeminiText("oops")).toEqual([]);
  });

  it("returns [] when no recognizable message rows", () => {
    expect(parseGeminiText(JSON.stringify([{ random: "shape" }]))).toEqual([]);
  });
});
