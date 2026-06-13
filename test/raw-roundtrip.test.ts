import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeArchiveInput } from "@core/normalize";
import { MarkdownVaultRepository } from "@core/repository/raw";
import { testTmpDir } from "./helpers";

const DIAGRAM_ANSWER = [
  "Here is the layout:",
  "",
  "## Overview", // an ordinary heading the model writes mid-message
  "",
  "```",
  "┌──────────┐",
  "│   core   │",
  "└────┬─────┘",
  "     ▼",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A --> B",
  "```",
  "",
  "## Notes",
  "",
  "- the diagram above must survive",
].join("\n");

function newRepo(): { repo: MarkdownVaultRepository; vault: string } {
  const dir = mkdtempSync(join(testTmpDir(), "raw-rt-"));
  const vault = join(dir, "vault");
  return { repo: new MarkdownVaultRepository(vault), vault };
}

describe("raw conversation round-trip", () => {
  it("preserves diagrams and headings through the sentinel write/read path", async () => {
    const { repo } = newRepo();
    const conv = normalizeArchiveInput({
      source: "claude-code",
      created_at: "2026-06-07T10:00:00.000Z",
      messages: [
        { role: "user", content: "draw the architecture" },
        { role: "assistant", content: DIAGRAM_ANSWER },
      ],
    });
    const { relativePath } = await repo.writeConversation(conv);
    const back = await repo.readConversation(relativePath);

    expect(back.messages).toHaveLength(2);
    expect(back.messages[1]?.content).toBe(DIAGRAM_ANSWER.trim());
  });

  it("round-trips content that itself contains a kh:msg sentinel line", async () => {
    // Regression: a message discussing the on-disk format (like this very
    // conversation) embeds a literal `<!-- kh:msg ... -->` line. Without
    // escaping it was parsed as a real divider and split the message in two.
    const { repo } = newRepo();
    const tricky = [
      "The divider format looks like:",
      "",
      "<!-- kh:msg assistant 2026-06-07T10:00:00.000Z -->",
      "",
      "and the parser splits on it.",
    ].join("\n");
    const conv = normalizeArchiveInput({
      source: "claude-code",
      created_at: "2026-06-07T10:00:00.000Z",
      messages: [
        { role: "user", content: "explain the divider" },
        { role: "assistant", content: tricky },
      ],
    });
    const { relativePath } = await repo.writeConversation(conv);
    const back = await repo.readConversation(relativePath);

    expect(back.messages).toHaveLength(2); // not split into 3+
    expect(back.messages[1]?.content).toBe(tricky.trim());
  });

  it("does NOT truncate legacy `# Assistant`-divider content at an ordinary `## ` heading", async () => {
    // Reproduces the diagram-deletion bug: legacy (non-sentinel) files were
    // read with a parser that clipped each message at the first `^## `,
    // deleting every diagram/code block that followed a heading.
    const { repo, vault } = newRepo();
    const legacy = [
      "---",
      "id: 019e0000-0000-7000-8000-000000000001",
      "source: claude-code",
      "created_at: '2026-06-07T10:00:00.000Z'",
      "---",
      "# User",
      "",
      "draw the architecture",
      "",
      "# Assistant",
      "",
      DIAGRAM_ANSWER,
    ].join("\n");
    const rel = "raw/conversations/2026/06/019e0000-0000-7000-8000-000000000001.md";
    const abs = join(vault, rel);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(vault, "raw", "conversations", "2026", "06"), {
      recursive: true,
    });
    writeFileSync(abs, legacy);

    const back = await repo.readConversation(rel);
    const assistant = back.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toContain("┌──────────┐"); // ASCII diagram
    expect(assistant?.content).toContain("```mermaid"); // mermaid fence
    expect(assistant?.content).toContain("## Notes"); // content after 2nd heading
  });

  it("still strips a trailing `## Related questions` template section", async () => {
    const { repo, vault } = newRepo();
    const legacy = [
      "---",
      "id: 019e0000-0000-7000-8000-000000000002",
      "source: claude-code",
      "created_at: '2026-06-07T10:00:00.000Z'",
      "---",
      "# User",
      "",
      "hello",
      "",
      "# Assistant",
      "",
      "the answer body",
      "",
      "## Related questions",
      "",
      "- what about X?",
    ].join("\n");
    const rel = "raw/conversations/2026/06/019e0000-0000-7000-8000-000000000002.md";
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(vault, "raw", "conversations", "2026", "06"), {
      recursive: true,
    });
    writeFileSync(join(vault, rel), legacy);

    const back = await repo.readConversation(rel);
    const assistant = back.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("the answer body");
    expect(back.related_questions).toEqual(["what about X?"]);
  });
});
