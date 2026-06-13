import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { MockLLMProvider } from "@core/llm/mock";
import { runNotesPipeline } from "@core/pipeline/notes";
import { NotesRepository } from "@core/repository/notes";
import type { ArchiveInput, Message } from "@core/schema";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

const BILINGUAL_BODY =
  "## 개요\n\n한글 설명입니다. [[Docker]]를 다룹니다.\n\n" +
  "---\n\n" +
  "## English\n\n### Overview\n\nEnglish mirror. Covers [[Docker]].\n";

function reaskPlan(notes: unknown[]): string {
  return JSON.stringify({ notes });
}

describe("runNotesPipeline — re-ask path (full conversation)", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup(
    messages: Message[],
    extra: Partial<ArchiveInput> = {},
  ): Promise<{
    config: ReturnType<typeof loadConfig>;
    db: DB;
    vault: string;
    conversationId: string;
    conversationPath: string;
  }> {
    const dir = mkdtempSync(join(testTmpDir(), "notes-reask-"));
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
        created_at: "2026-06-07T10:00:00.000Z",
        // No scope → full conversation → re-ask path.
        messages,
        ...extra,
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

  it("re-asks the LLM from user questions, writes a bilingual note with tags", async () => {
    const { config, vault, conversationId, conversationPath } = await setup(
      [
        { role: "user", content: "docker가 뭐야?" },
        { role: "assistant", content: "Docker는 컨테이너 도구. (요약)" },
      ],
      { tags: ["infra", "docker"] },
    );
    const llm = new MockLLMProvider();
    llm.enqueue(
      reaskPlan([
        {
          title: "Docker 기초",
          topics: ["docker"],
          question_indexes: [0],
          needs_canvas: false,
        },
      ]),
      BILINGUAL_BODY,
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.action).toBe("create");
    expect(result.canvases).toHaveLength(0);

    const notePath = join(vault, "notes", "Docker_기초.md");
    expect(existsSync(notePath)).toBe(true);
    const parsed = matter(readFileSync(notePath, "utf8"));
    expect(parsed.data.title).toBe("Docker 기초");
    expect(parsed.data.tags).toEqual(["infra", "docker"]);
    expect(parsed.data.sources).toEqual([conversationId]);
    // Korean half precedes the English half.
    const koIdx = parsed.content.indexOf("한글 설명");
    const enIdx = parsed.content.indexOf("English mirror");
    expect(koIdx).toBeGreaterThanOrEqual(0);
    expect(enIdx).toBeGreaterThan(koIdx);

    // The write prompt received the user question AND the assistant summary
    // as context.
    const writeCall = llm.calls[1]!;
    expect(writeCall.prompt).toContain("docker가 뭐야?");
    expect(writeCall.prompt).toContain("(요약)");
  });

  it("generates a concept canvas and links it back from the note body", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "컨테이너 네트워킹 전체 흐름 설명해줘" },
      { role: "assistant", content: "veth + docker0 + iptables NAT (요약)" },
    ]);
    const llm = new MockLLMProvider();
    llm.enqueue(
      reaskPlan([
        {
          title: "컨테이너 네트워킹",
          topics: ["docker", "networking"],
          question_indexes: [0],
          needs_canvas: true,
        },
      ]),
      BILINGUAL_BODY,
      JSON.stringify({
        nodes: [
          { id: "veth", label: "veth pair = 가상 랜선", kind: "concept" },
          { id: "s1", label: "1. 패킷이 eth0 진입", kind: "step" },
        ],
        edges: [{ from: "veth", to: "s1" }],
      }),
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    const canvasRel = join("canvas", "컨테이너_네트워킹.canvas");
    expect(result.canvases).toEqual([canvasRel]);
    expect(existsSync(join(vault, canvasRel))).toBe(true);

    // Note body links back to the canvas in both language halves.
    const note = readFileSync(
      join(vault, "notes", "컨테이너_네트워킹.md"),
      "utf8",
    );
    expect(note).toContain(`[[${canvasRel}|개념도]]`);
    expect(note).toContain(`[[${canvasRel}|Concept map]]`);
    expect(note).toContain("## 다이어그램");
    expect(note).toContain("## Diagram");
  });

  it("always creates a fresh note — never merges into an existing one", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "Redis가 뭐야?" },
      { role: "assistant", content: "in-memory store (요약)" },
    ]);
    // Seed an existing note with the SAME title; re-ask must not merge into it.
    const repo = new NotesRepository(vault);
    const seeded = await repo.write({
      title: "Redis 기초",
      topics: ["redis"],
      body: "## 기존\n\n기존 내용.\n",
      sourceConversationId: "prior-conversation",
    });
    const seededId = matter(readFileSync(seeded.absolutePath, "utf8")).data.id;

    const llm = new MockLLMProvider();
    llm.enqueue(
      reaskPlan([
        {
          title: "Redis 기초",
          topics: ["redis"],
          question_indexes: [0],
          needs_canvas: false,
        },
      ]),
      BILINGUAL_BODY,
    );

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.action).toBe("create");
    // Overwrites the same filename with fresh content (no merge of bodies),
    // and the merge prompt never received the prior body.
    const parsed = matter(readFileSync(seeded.absolutePath, "utf8"));
    expect(parsed.content).not.toContain("기존 내용");
    expect(parsed.content).toContain("한글 설명");
    // sources is NOT accumulated from the prior unrelated note.
    expect(parsed.data.sources).toEqual([conversationId]);
    expect(seededId).toBeTruthy();
  });

  it("is a no-op when the re-ask plan JSON is malformed", async () => {
    const { config, vault, conversationId, conversationPath } = await setup([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const llm = new MockLLMProvider();
    llm.enqueue("not json");

    const result = await runNotesPipeline(config, llm, {
      conversationId,
      conversationPath,
    });

    expect(result.notes).toHaveLength(0);
    expect(existsSync(join(vault, "notes"))).toBe(false);
  });
});
