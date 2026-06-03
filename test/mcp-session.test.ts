import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { createKnowledgeHubServer } from "@core/mcp";
import { SequentialQueue } from "@core/queue/sequential-queue";
import { claudeProjectDirName } from "@core/transcript/locate";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

const SESSION_CWD = "/tmp/fake_project";

/** Minimal Claude Code JSONL: 2 user + 2 assistant turns. */
const SESSION_JSONL =
  [
    {
      type: "user",
      message: { role: "user", content: "What is Redis?" },
      cwd: SESSION_CWD,
      timestamp: "2026-06-03T01:00:00.000Z",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "An in-memory key-value store." }],
      },
      timestamp: "2026-06-03T01:00:05.000Z",
    },
    {
      type: "user",
      message: { role: "user", content: "아카이빙해" },
      timestamp: "2026-06-03T01:01:00.000Z",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Archiving now." }] },
      timestamp: "2026-06-03T01:01:05.000Z",
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n";

describe("archive_session MCP tool", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup(captureMode: "manual" | "auto"): Promise<{
    client: Client;
    db: DB;
    vault: string;
  }> {
    const dir = mkdtempSync(join(testTmpDir(), "mcp-session-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);

    // Fake ~/.claude/projects with one session transcript for SESSION_CWD.
    const projectsRoot = join(dir, "projects");
    const projectDir = join(projectsRoot, claudeProjectDirName(SESSION_CWD));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), SESSION_JSONL);

    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
        capture: { mode: captureMode },
        logging: { enabled: false },
      },
    });
    const opened = openTestDb(vault);
    openHandle = opened.sqlite;

    const server = createKnowledgeHubServer({
      config,
      db: opened.db,
      sqlite: opened.sqlite,
      queue: new SequentialQueue(),
      projectsRoot,
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { client, db: opened.db, vault };
  }

  it("manual mode: archives the WHOLE session transcript from disk", async () => {
    const { client, vault } = await setup("manual");

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("archive_session");

    const result = await client.callTool({
      name: "archive_session",
      arguments: { cwd: SESSION_CWD, intent: "아카이빙해" },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as { message_count: number; path: string };

    // All 4 turns captured — not just the triggering message.
    expect(payload.message_count).toBe(4);
    const raw = readFileSync(join(vault, payload.path), "utf8");
    expect(raw).toContain("What is Redis?");
    expect(raw).toContain("An in-memory key-value store.");
    expect(raw).toContain("아카이빙해");
  });

  it("manual mode: re-archiving an unchanged session is a duplicate no-op", async () => {
    const { client } = await setup("manual");
    const first = await client.callTool({
      name: "archive_session",
      arguments: { cwd: SESSION_CWD },
    });
    const second = await client.callTool({
      name: "archive_session",
      arguments: { cwd: SESSION_CWD },
    });
    const p1 = JSON.parse(
      (first.content as Array<{ text: string }>)[0]!.text,
    ) as { conversation_id: string };
    const p2 = JSON.parse(
      (second.content as Array<{ text: string }>)[0]!.text,
    ) as { conversation_id: string; skipped_duplicate?: boolean };
    expect(p2.skipped_duplicate).toBe(true);
    expect(p2.conversation_id).toBe(p1.conversation_id);
  });

  it("auto mode: archive_session is not listed and calls are rejected", async () => {
    const { client } = await setup("auto");

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain("archive_session");

    const result = await client.callTool({
      name: "archive_session",
      arguments: { cwd: SESSION_CWD },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(
      /capture\.mode/,
    );
  });
});
