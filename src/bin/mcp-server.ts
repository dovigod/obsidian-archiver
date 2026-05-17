#!/usr/bin/env node
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Role } from "@constants/role";
import { Source } from "@constants/source";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import { createDb } from "@core/db/client";
import { JobsRepository } from "@core/db/repository/jobs";
import { SequentialQueue } from "@core/queue/sequential-queue";
import { ArchiveInputSchema } from "@core/schema";

const ARCHIVE_TOOL_NAME = "archive_conversation";

const archiveInputJsonSchema = {
  type: "object",
  required: ["source", "messages"],
  properties: {
    source: {
      type: "string",
      enum: Object.values(Source),
    },
    model: { type: "string" },
    created_at: { type: "string", description: "ISO 8601 timestamp" },
    cwd: { type: "string" },
    project: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    conversation_type: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    git: {
      type: "object",
      properties: {
        repo: { type: "string" },
        branch: { type: "string" },
        commit: { type: "string" },
      },
    },
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: {
            type: "string",
            enum: Object.values(Role),
          },
          content: { type: "string" },
          timestamp: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    metadata: { type: "object" },
  },
} as const;

// One queue for the lifetime of the MCP server process. Every conversation-
// processing request runs through it so the raw write + git commit stays
// strictly sequential.
const processingQueue = new SequentialQueue();

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, sqlite } = createDb({
    path: join(config.vault.path, config.storage.sqlite.path),
    journalMode: config.storage.sqlite.journal_mode,
    busyTimeoutMs: config.storage.sqlite.busy_timeout_ms,
    synchronous: config.storage.sqlite.synchronous,
    migrate: true,
  });

  // Recover any jobs left running from a prior crashed process.
  const jobs = new JobsRepository(db, sqlite);
  jobs.reclaimStuck();

  const server = new Server(
    { name: "knowledge-hub", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: ARCHIVE_TOOL_NAME,
        description:
          "Archive a normalized conversation. Writes raw md to the vault, inserts a conversations row, and enqueues a Stage 2 extract job consumed by `kh worker`.",
        inputSchema: archiveInputJsonSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== ARCHIVE_TOOL_NAME) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Unknown tool: ${request.params.name}` },
        ],
      };
    }

    const parsed = ArchiveInputSchema.safeParse(request.params.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("; ")}`,
          },
        ],
      };
    }

    try {
      const result = await processingQueue.enqueue(() =>
        archiveConversation({ config, db, sqlite }, parsed.data),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                conversation_id: result.conversation.id,
                path: result.relativePath,
                extract_job_id: result.extractJobId,
                committed: result.committed,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: `archive failed: ${(err as Error).message}` },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
