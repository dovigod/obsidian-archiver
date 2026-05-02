import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import matter from "gray-matter";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { testTmpDir } from "./helpers";

describe("archiveConversation (Stage 1)", () => {
  it("writes a markdown file with valid frontmatter", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-write-"));
    const vault = join(dir, "vault");
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });

    const result = await archiveConversation(config, {
      source: "claude-code",
      created_at: "2026-05-02T14:22:00.000Z",
      project: ["tada-wallet"],
      topics: ["redis", "redis", "  "],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    assert.match(
      result.relativePath,
      /^raw\/conversations\/2026\/05\/[0-9a-f-]+\.md$/,
    );
    const text = readFileSync(result.absolutePath, "utf8");
    const parsed = matter(text);
    assert.equal(parsed.data.source, "claude-code");
    assert.equal(parsed.data.id, result.conversation.id);
    assert.deepEqual(parsed.data.project, ["tada-wallet"]);
    assert.deepEqual(parsed.data.topics, ["redis"]); // dedup + trim
    assert.match(parsed.content, /# User\n/);
    assert.match(parsed.content, /# Assistant\n/);
    assert.equal(result.committed, false);
  });

  it("rejects empty message arrays via schema", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "archive-reject-empty-msgs-"));
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: join(dir, "vault") },
        git: { auto_commit: false },
      },
    });

    await assert.rejects(
      archiveConversation(config, {
        source: "manual",
        messages: [],
      }),
    );
  });
});
