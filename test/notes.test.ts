import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { MockLLMProvider } from "@core/llm/mock";
import { runNotesPipeline } from "@core/pipeline/notes";
import { NotesRepository } from "@core/repository/notes";
import type { Message } from "@core/schema";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

const EMAIL_ANSWER =
  "MX records tell the world which server receives a domain's email. " +
  "Lower priority numbers are tried first.";
const BITCOIN_ANSWER =
  "Bitcoin has no account balances — only UTXOs, spent whole like cash, " +
  "with change returned to your own address.";

function plan(notes: unknown[]): string {
  return JSON.stringify({ notes });
}

describe("runNotesPipeline — transcription path (scope: answer)", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup(messages: Message[]): Promise<{
    config: ReturnType<typeof loadConfig>;
    db: DB;
    vault: string;
    conversationId: string;
    conversationPath: string;
  }> {
    const dir = mkdtempSync(join(testTmpDir(), "notes-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
        logging: { enabled: false },
      },
    });
    const opened = openTestDb(vault);
    openHandle = opened.sqlite;
    const archived = await archiveConversation(
      { config, db: opened.db, sqlite: opened.sqlite },
      {
        source: "claude-code",
        created_at: "2026-06-03T10:00:00.000Z",
        // The transcription path is now reserved for `archive_answer`
        // (scope: answer); full conversations route to the re-ask path.
        scope: "answer",
        messages,
      },
    );
    return {
      config,
      db: opened.db,
      vault,
      conversationId: archived.conversation.id,
      conversationPath: archived.relativePath,
    };
  }

  it("creates one topic note from assistant turns; no canvas for a single easy topic", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "mx 상태값이 뭐야?" },
      { role: "assistant", content: EMAIL_ANSWER },
    ]);
    // Enable auto-commit for this case to verify the commit message carries
    // the note title (what was archived), not an opaque conversation id.
    config.git.auto_commit = true;
    const llm = new MockLLMProvider();
    llm.enqueue(
      plan([
        {
          action: "create",
          title: "Email DNS & deliverability",
          topics: ["dns", "email"],
          assistant_indexes: [0],
          needs_canvas: false,
        },
      ]),
      "## MX records\n\n[[MX 레코드]] tells the world which server receives email.\n",
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.action).toBe("create");
    expect(result.canvases).toHaveLength(0);

    const notePath = join(vault, "notes", "Email_DNS_&_deliverability.md");
    expect(existsSync(notePath)).toBe(true);
    const parsed = matter(readFileSync(notePath, "utf8"));
    expect(parsed.data.title).toBe("Email DNS & deliverability");
    expect(parsed.data.topics).toEqual(["dns", "email"]);
    expect(parsed.data.sources).toEqual([conversationId]);
    expect(parsed.content).toContain("[[MX 레코드]]");
    // User turns are dropped — note carries only distilled assistant content.
    expect(parsed.content).not.toContain("mx 상태값이 뭐야");
    expect(existsSync(join(vault, "canvas"))).toBe(false);

    // Commit message names the note, so `git log` reads as an archive index.
    expect(result.committed).toBe(true);
    const log = await simpleGit({ baseDir: vault }).log();
    expect(log.latest!.message).toBe("notes: Email DNS & deliverability");
    expect(log.latest!.body).toContain(
      "- create: Email DNS & deliverability (notes/Email_DNS_&_deliverability.md)",
    );
    expect(log.latest!.body).toContain(`conversation: ${conversationId}`);
  });

  it("splits two topics into two notes and writes an overview canvas", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "MX 레코드 알려줘" },
      { role: "assistant", content: EMAIL_ANSWER },
      { role: "user", content: "비트코인 트랜잭션 처리 방법은?" },
      { role: "assistant", content: BITCOIN_ANSWER },
    ]);
    const llm = new MockLLMProvider();
    llm.enqueue(
      plan([
        {
          action: "create",
          title: "Email deliverability",
          topics: ["email"],
          assistant_indexes: [0],
          needs_canvas: false,
        },
        {
          action: "create",
          title: "Bitcoin transactions",
          topics: ["bitcoin"],
          assistant_indexes: [1],
          needs_canvas: false,
        },
      ]),
      "## MX\n\nEmail body.\n",
      "## UTXO\n\nBitcoin body.\n",
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(2);
    expect(existsSync(join(vault, "notes", "Email_deliverability.md"))).toBe(
      true,
    );
    expect(existsSync(join(vault, "notes", "Bitcoin_transactions.md"))).toBe(
      true,
    );

    const canvasPath = join(vault, "canvas", `${conversationId}.canvas`);
    expect(result.canvases).toContain(join("canvas", `${conversationId}.canvas`));
    const canvas = JSON.parse(readFileSync(canvasPath, "utf8")) as {
      nodes: Array<{ type: string; file?: string }>;
    };
    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.nodes.map((n) => n.file)).toEqual([
      join("notes", "Email_deliverability.md"),
      join("notes", "Bitcoin_transactions.md"),
    ]);
  });

  it("merges into an existing note, accumulating sources and keeping its id", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "IP reputation은 뭐야?" },
      { role: "assistant", content: "Reputation is a trust score for sender IPs." },
    ]);
    const repo = new NotesRepository(vault);
    const seeded = await repo.write({
      title: "Email deliverability",
      topics: ["email"],
      body: "## MX\n\nExisting MX content.\n",
      sourceConversationId: "prior-conversation",
    });
    const seededId = matter(readFileSync(seeded.absolutePath, "utf8")).data.id;

    const llm = new MockLLMProvider();
    llm.enqueue(
      plan([
        {
          action: "merge",
          target: seeded.file,
          title: "Email deliverability",
          topics: ["reputation"],
          assistant_indexes: [0],
          needs_canvas: false,
        },
      ]),
      "## MX\n\nExisting MX content.\n\n## IP reputation\n\nTrust score for sender IPs.\n",
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.action).toBe("merge");
    const parsed = matter(readFileSync(seeded.absolutePath, "utf8"));
    expect(parsed.data.id).toBe(seededId);
    expect(parsed.data.sources).toEqual(["prior-conversation", conversationId]);
    expect(parsed.data.topics).toEqual(["email", "reputation"]);
    expect(parsed.content).toContain("## IP reputation");
    // The merge prompt received the existing body to integrate.
    expect(llm.calls[1]!.prompt).toContain("Existing MX content.");
  });

  it("writes a concept canvas when the plan flags the user struggled (needs_canvas)", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "비트코인 트랜잭션 다시 쉽게 설명해줘" },
      { role: "assistant", content: BITCOIN_ANSWER },
    ]);
    const llm = new MockLLMProvider();
    llm.enqueue(
      plan([
        {
          action: "create",
          title: "Bitcoin transactions",
          topics: ["bitcoin"],
          assistant_indexes: [0],
          needs_canvas: true,
        },
      ]),
      "## UTXO\n\nBitcoin body.\n",
      JSON.stringify({
        nodes: [
          { id: "utxo", label: "UTXO = 미사용 출력", kind: "concept" },
          { id: "s1", label: "1. 지갑이 UTXO 선택 + 서명", kind: "step" },
          { id: "s2", label: "2. 멤풀 대기", kind: "step" },
        ],
        edges: [
          { from: "s1", to: "s2" },
          { from: "utxo", to: "s1", label: "입력" },
          { from: "ghost", to: "s1" }, // dangling — must be dropped
        ],
      }),
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    const rel = join("canvas", "Bitcoin_transactions.canvas");
    expect(result.canvases).toEqual([rel]);
    const canvas = JSON.parse(readFileSync(join(vault, rel), "utf8")) as {
      nodes: Array<{ id: string; type: string; file?: string; text?: string }>;
      edges: Array<{ fromNode: string; toNode: string; label?: string }>;
    };
    // Note file node + 3 concept/step text nodes.
    expect(canvas.nodes).toHaveLength(4);
    expect(
      canvas.nodes.find((n) => n.type === "file")?.file,
    ).toBe("notes/Bitcoin_transactions.md");
    expect(canvas.nodes.filter((n) => n.type === "text")).toHaveLength(3);
    // Dangling edge dropped, labeled edge kept.
    expect(canvas.edges).toHaveLength(2);
    expect(canvas.edges.find((e) => e.label === "입력")).toBeTruthy();
  });

  it("is a no-op when the plan JSON is malformed", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const llm = new MockLLMProvider();
    llm.enqueue("this is not json at all");

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(0);
    expect(result.canvases).toHaveLength(0);
    expect(existsSync(join(vault, "notes"))).toBe(false);
  });
});
