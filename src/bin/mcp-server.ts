#!/usr/bin/env node
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
import { ArchiveInputSchema } from "@core/schema";

const ARCHIVE_TOOL_NAME = "archive_conversation";

const archiveInputJsonSchema = {
  type: "object",
  // The enum lists below are derived from the @constants/* sources so the JSON
  // Schema stays in sync with the zod schema and the const-object types.
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

async function main(): Promise<void> {
  const server = new Server(
    { name: "knowledge-hub", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: ARCHIVE_TOOL_NAME,
        description:
          "Archive a normalized conversation into the knowledge-hub vault as raw markdown.",
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
      const config = loadConfig();
      const result = await archiveConversation(config, parsed.data);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: result.conversation.id,
                path: result.relativePath,
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
