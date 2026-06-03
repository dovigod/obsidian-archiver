import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@core/config";
import type { SqliteHandle } from "@core/db/client";
import { createKnowledgeHubServer } from "@core/mcp";
import { SequentialQueue } from "@core/queue/sequential-queue";
import { MarkdownVaultRepository } from "@core/repository/raw";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

const QUESTION = "What is a bloom filter?";
const ANSWER =
  "A probabilistic data structure that tells you an element is " +
  "definitely absent or possibly present.";

describe("archive_answer MCP tool", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function setup(sessionTool?: boolean): Promise<{
    client: Client;
    vault: string;
  }> {
    const dir = mkdtempSync(join(testTmpDir(), "mcp-answer-"));
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

    const server = createKnowledgeHubServer({
      config,
      db: opened.db,
      sqlite: opened.sqlite,
      queue: new SequentialQueue(),
      ...(sessionTool !== undefined ? { sessionTool } : {}),
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { client, vault };
  }

  it("is listed regardless of the archive_session gating", async () => {
    // HTTP-like config (remote ChatGPT): sessionTool=false.
    const remote = await setup(false);
    const remoteTools = (await remote.client.listTools()).tools.map(
      (t) => t.name,
    );
    expect(remoteTools).toContain("archive_answer");
    expect(remoteTools).toContain("archive_conversation");
    expect(remoteTools).not.toContain("archive_session");
    openHandle?.close();
    openHandle = null;

    // stdio/manual config: all three tools coexist.
    const local = await setup(true);
    const localTools = (await local.client.listTools()).tools.map(
      (t) => t.name,
    );
    expect(localTools).toContain("archive_answer");
    expect(localTools).toContain("archive_conversation");
    expect(localTools).toContain("archive_session");
  });

  it("archives a question + answer pair marked scope: answer", async () => {
    const { client, vault } = await setup(false);

    const result = await client.callTool({
      name: "archive_answer",
      arguments: {
        source: "openai",
        model: "gpt-5",
        question: QUESTION,
        answer: ANSWER,
        intent: "이 답변만 아카이브해",
        topics: ["data-structures"],
      },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as { conversation_id: string; scope: string; path: string };
    expect(payload.scope).toBe("answer");

    const raw = readFileSync(join(vault, payload.path), "utf8");
    expect(raw).toContain("scope: answer");
    expect(raw).toContain("intent: 이 답변만 아카이브해");
    expect(raw).toContain(`# User\n\n${QUESTION}`);
    expect(raw).toContain(`# Assistant\n\n${ANSWER}`);

    // Round-trip: the on-disk file parses back with scope intact.
    const repo = new MarkdownVaultRepository(vault);
    const conv = await repo.readConversation(payload.path);
    expect(conv.scope).toBe("answer");
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0]).toMatchObject({
      role: "user",
      content: QUESTION,
    });
    expect(conv.messages[1]).toMatchObject({
      role: "assistant",
      content: ANSWER,
    });
  });

  it("accepts an answer without a question (single assistant turn)", async () => {
    const { client, vault } = await setup(false);

    const result = await client.callTool({
      name: "archive_answer",
      arguments: { source: "openai", answer: ANSWER },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    ) as { path: string };

    const repo = new MarkdownVaultRepository(vault);
    const conv = await repo.readConversation(payload.path);
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.role).toBe("assistant");
  });

  it("re-archiving the same answer is a duplicate no-op", async () => {
    const { client } = await setup(false);
    const args = { source: "openai", question: QUESTION, answer: ANSWER };
    const first = await client.callTool({
      name: "archive_answer",
      arguments: args,
    });
    const second = await client.callTool({
      name: "archive_answer",
      arguments: args,
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

  it("rejects a payload without an answer", async () => {
    const { client } = await setup(false);
    const result = await client.callTool({
      name: "archive_answer",
      arguments: { source: "openai", question: QUESTION },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(
      /answer/,
    );
  });
});
