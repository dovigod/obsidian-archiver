import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ArchiveScope } from "@constants/archive-scope";
import { CaptureMode } from "@constants/capture-mode";
import { Role } from "@constants/role";
import { Source } from "@constants/source";
import { archiveConversation } from "@core/archive";
import type { Config } from "@core/config";
import type { DB, SqliteHandle } from "@core/db/client";
import { loggerFromConfig, type Logger } from "@core/log";
import type { SequentialQueue } from "@core/queue/sequential-queue";
import {
  type ArchiveInput,
  ArchiveInputSchema,
  type Fidelity,
  SourceSchema,
} from "@core/schema";
import {
  parseTranscriptFile,
  transcriptToArchiveInput,
} from "@core/transcript";
import { locateClaudeSessionTranscript } from "@core/transcript/locate";

export const ARCHIVE_TOOL_NAME = "archive_conversation";
export const ARCHIVE_SESSION_TOOL_NAME = "archive_session";
export const ARCHIVE_ANSWER_TOOL_NAME = "archive_answer";

export const ArchiveAnswerInputSchema = z.object({
  source: SourceSchema,
  model: z.string().optional(),
  created_at: z.string().datetime().optional(),
  /** The user prompt that produced the answer, verbatim. */
  question: z.string().optional(),
  /** The assistant answer to archive, verbatim and complete. */
  answer: z.string().min(1),
  project: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  /** Triggering user phrase, verbatim. */
  intent: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ArchiveAnswerInput = z.infer<typeof ArchiveAnswerInputSchema>;

/**
 * Map an `archive_answer` payload onto the shared Stage 1 `ArchiveInput`:
 * the optional question becomes a user turn, the answer an assistant turn,
 * and the record is marked `scope: answer` so the frontmatter distinguishes
 * it from a full-conversation archive.
 */
export function archiveAnswerToArchiveInput(
  input: ArchiveAnswerInput,
): ArchiveInput {
  return {
    source: input.source,
    ...(input.model ? { model: input.model } : {}),
    ...(input.created_at ? { created_at: input.created_at } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.topics ? { topics: input.topics } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    messages: [
      ...(input.question && input.question.trim().length > 0
        ? [{ role: Role.User, content: input.question }]
        : []),
      { role: Role.Assistant, content: input.answer },
    ],
    scope: ArchiveScope.Answer,
  };
}

const archiveAnswerInputJsonSchema = {
  type: "object",
  required: ["source", "answer"],
  properties: {
    source: {
      type: "string",
      enum: Object.values(Source),
    },
    model: { type: "string" },
    created_at: { type: "string", description: "ISO 8601 timestamp" },
    question: {
      type: "string",
      description:
        "The user prompt that produced the answer, VERBATIM. Strongly " +
        "recommended — it preserves the context the answer responds to. " +
        "Omit only when there is no meaningful question (e.g. the user asked " +
        "to archive a standalone piece of generated text).",
    },
    answer: {
      type: "string",
      description:
        "The assistant answer to archive, VERBATIM and COMPLETE — the full " +
        "text of the single answer the user pointed at, not a summary or " +
        "paraphrase of it.",
    },
    project: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    intent: {
      type: "string",
      description:
        'The user\'s triggering phrase (e.g. "이 답변만 아카이브해"), verbatim.',
    },
    metadata: { type: "object" },
  },
} as const;

export const ArchiveSessionInputSchema = z.object({
  /** Working directory of the Claude Code session (used to find the transcript). */
  cwd: z.string().min(1),
  /** Explicit session UUID; defaults to the most recently active session for cwd. */
  session_id: z.string().optional(),
  project: z.array(z.string()).optional(),
  topics: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  /** Triggering user phrase, verbatim. */
  intent: z.string().optional(),
});
export type ArchiveSessionInput = z.infer<typeof ArchiveSessionInputSchema>;

const archiveSessionInputJsonSchema = {
  type: "object",
  required: ["cwd"],
  properties: {
    cwd: {
      type: "string",
      description:
        "Absolute working directory of this Claude Code session. The server " +
        "uses it to locate the session transcript on disk.",
    },
    session_id: {
      type: "string",
      description:
        "Session UUID, if known. When omitted the most recently active " +
        "session for cwd is archived (normally the current one).",
    },
    project: { type: "array", items: { type: "string" } },
    topics: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    intent: {
      type: "string",
      description: "The user's triggering phrase, verbatim.",
    },
  },
} as const;

export const archiveInputJsonSchema = {
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
      description:
        "The COMPLETE conversation transcript: every user AND assistant turn " +
        "from the first message up to now, in chronological order. Never pass " +
        "only the last message or only the archive request itself — a payload " +
        "without at least one assistant message is rejected.",
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
    partial: {
      type: "boolean",
      description:
        "Set true when you CANNOT reconstruct the complete transcript " +
        "(e.g. earlier turns were summarized out of your context). Then " +
        "send every turn you still have VERBATIM — newest turns plus " +
        "whatever earlier original text remains — and never pass " +
        "summaries off as original messages. Omit (or false) when the " +
        "payload is the complete history.",
    },
    intent: {
      type: "string",
      description: "The user's triggering phrase (e.g. \"sync to kh\"), verbatim.",
    },
  },
} as const;

/**
 * Heuristic guard against callers (observed: ChatGPT via MCP connector)
 * passing only the triggering message instead of the full transcript.
 * A conversation worth archiving always has at least one assistant turn.
 * Returns an instructive error string for the calling model, or null when
 * the payload looks like a real transcript.
 */
export function detectTruncatedTranscript(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string | null {
  const hasAssistant = messages.some((m) => m.role === Role.Assistant);
  if (!hasAssistant) {
    return (
      "Rejected: `messages` contains no assistant turn, which means the full " +
      "conversation transcript was not provided (only the archive request " +
      "itself?). Retry with the COMPLETE history of this conversation — every " +
      "user and assistant message from the first turn up to now, verbatim, " +
      "in chronological order."
    );
  }
  return null;
}

export interface McpServerDeps {
  config: Config;
  db: DB;
  sqlite: SqliteHandle;
  /**
   * Every conversation-processing request runs through this queue so the
   * raw write + git commit stays strictly sequential across the process.
   */
  queue: SequentialQueue;
  /** Override the Claude Code projects root (tests). Defaults to ~/.claude/projects. */
  projectsRoot?: string;
  /** Inject a logger (tests). When omitted, built from `config.logging`. */
  logger?: Logger;
  /**
   * Expose the `archive_session` tool (reads Claude Code transcripts from
   * this machine's disk). Defaults to `capture.mode === manual`. The HTTP
   * server passes `false`: remote callers (ChatGPT) have no local Claude
   * Code session, and advertising a tool they cannot satisfy makes the
   * calling model conclude archiving is impossible.
   */
  sessionTool?: boolean;
  /**
   * Stamp every `archive_conversation` capture with this fidelity,
   * overriding whatever the caller claims. The HTTP server passes
   * `summarized`: remote models (observed: ChatGPT) compress their own
   * turns when serializing a conversation into tool args, so transcripts
   * arriving over HTTP are never trustworthy as verbatim. Local stdio
   * captures leave this unset.
   */
  forcedFidelity?: Fidelity;
}

/**
 * Build a knowledge-hub MCP `Server` with the `archive_conversation` tool
 * registered. Transport-agnostic: callers connect it to stdio or
 * Streamable HTTP.
 */
export function createKnowledgeHubServer(deps: McpServerDeps): Server {
  const { config, db, sqlite, queue, projectsRoot } = deps;
  const log = deps.logger ?? loggerFromConfig(config.logging, "mcp");

  const server = new Server(
    { name: "knowledge-hub", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // capture.mode = manual (default): "archive this" means the WHOLE session —
  // expose archive_session, which reads the full transcript from disk instead
  // of trusting the calling model to serialize its history into tool args.
  // capture.mode = auto (per-conversation Stop-hook capture): keep the
  // message-payload tool only.
  const sessionToolEnabled =
    deps.sessionTool ?? config.capture.mode === CaptureMode.Manual;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(sessionToolEnabled
        ? [
            {
              name: ARCHIVE_SESSION_TOOL_NAME,
              description:
                "Archive the ENTIRE current Claude Code session into the " +
                "knowledge-hub vault. The server reads the full session " +
                "transcript from disk (~/.claude/projects/...), so every turn " +
                "is captured regardless of what is still in your context " +
                "window. **Prefer this tool over archive_conversation for " +
                "Claude Code sessions.**\n" +
                "\n" +
                "**Invoke ONLY when the user expresses intent to save / sync / " +
                "archive** (e.g. \"archive this\", \"이거 아카이브해\", " +
                "\"지식허브에 저장\", \"아카이빙해\") — never unsolicited.\n" +
                "\n" +
                "Pass the session's working directory as `cwd` and the " +
                "triggering phrase verbatim as `intent`.\n" +
                "\n" +
                "You do NOT author any summary or note content — the server " +
                "stores the verbatim transcript, then a background worker " +
                "distills it into topic notes (`notes/`): user turns are " +
                "dropped, assistant content is lightly edited into " +
                "explanatory prose, topics are grouped from the USER's " +
                "questions (similar themes merged, including into existing " +
                "notes), and Obsidian `.canvas` concept maps are generated " +
                "when the user seemed to struggle with a topic or multiple " +
                "topics emerged.",
              inputSchema: archiveSessionInputJsonSchema,
            },
          ]
        : []),
      {
        name: ARCHIVE_TOOL_NAME,
        description:
          "Archive the current conversation into the knowledge-hub vault.\n" +
          (sessionToolEnabled
            ? "\n**For Claude Code sessions use `archive_session` instead** — " +
              "it reads the complete transcript from disk. This tool is for " +
              "sources without a local transcript (ChatGPT, Gemini, etc.).\n"
            : "") +
          "\n" +
          "**`messages` MUST be the COMPLETE transcript of this conversation** —\n" +
          "every user and assistant turn from the very first message up to now,\n" +
          "verbatim and in order. Do NOT summarize, do NOT truncate, and do NOT\n" +
          "send only the message that asked for archiving; a payload with no\n" +
          "assistant turns is rejected.\n" +
          "\n" +
          "**If the complete original text is genuinely unavailable** (long\n" +
          "conversation, earlier turns summarized out of your context): do NOT\n" +
          "give up and do NOT fabricate. Send every turn you still have verbatim\n" +
          "and set `partial: true` — the archive is flagged best-effort and can\n" +
          "be superseded later by a lossless import from the official data\n" +
          "export.\n" +
          "\n" +
          "**Invoke this tool ONLY when the user expresses intent to save / sync /\n" +
          "archive the current conversation into knowledge-hub.** Do NOT call it on\n" +
          "every Stop event or unsolicited — capture is intent-driven, not automatic.\n" +
          "\n" +
          'Trigger phrases include (English + Korean variants the user may type):\n' +
          '  - "archive this", "save this conversation", "sync to kh"\n' +
          '  - "flush this session into knowledge-hub", "remember this"\n' +
          '  - "이거 아카이브해", "지식허브에 저장", "이 대화 동기화"\n' +
          "\n" +
          "Record the triggering phrase verbatim under `intent` so it shows up in\n" +
          "the audit trail.\n" +
          "\n" +
          "You do NOT author any summary or note content — the server stores the\n" +
          "verbatim transcript, then a background worker distills it into topic\n" +
          "notes (`notes/`): user turns are dropped, assistant content is lightly\n" +
          "edited into explanatory prose, topics are grouped from the USER's\n" +
          "questions (similar themes merged, including into existing notes), and\n" +
          "Obsidian `.canvas` concept maps are generated when the user seemed to\n" +
          "struggle with a topic or multiple topics emerged.\n" +
          "\n" +
          "**To archive only a single answer (not the whole conversation), use\n" +
          "`archive_answer` instead.**",
        inputSchema: archiveInputJsonSchema,
      },
      {
        name: ARCHIVE_ANSWER_TOOL_NAME,
        description:
          "Archive ONE assistant answer (optionally with the question that " +
          "produced it) into the knowledge-hub vault — NOT the whole " +
          "conversation. Use this when the user points at a single answer; " +
          "use `archive_conversation` when they want the entire conversation.\n" +
          "\n" +
          "Unlike `archive_conversation`, there is NO full-transcript " +
          "requirement here: you only need the one answer (and ideally its " +
          "question), both VERBATIM. Never summarize or paraphrase them — if " +
          "you can still see the original text, send it exactly as written.\n" +
          "\n" +
          "**Invoke ONLY when the user expresses intent to save / archive a " +
          "specific answer** (e.g. \"archive this answer\", \"save just this " +
          "answer\", \"이 답변만 아카이브해\", \"방금 답변 저장해\", \"이 답변 " +
          "지식허브에 저장\") — never unsolicited. Record the triggering " +
          "phrase verbatim under `intent`.\n" +
          "\n" +
          "You do NOT author any summary or note content — the server stores " +
          "the verbatim Q&A (marked `scope: answer` in frontmatter), then a " +
          "background worker lightly edits the answer into an explanatory " +
          "topic note under `notes/`, merging it into an existing note when " +
          "the vault already covers a similar topic.",
        inputSchema: archiveAnswerInputJsonSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === ARCHIVE_SESSION_TOOL_NAME) {
      if (!sessionToolEnabled) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "archive_session is only available when capture.mode is " +
                '"manual" (current mode archives per conversation).',
            },
          ],
        };
      }
      const parsed = ArchiveSessionInputSchema.safeParse(
        request.params.arguments,
      );
      if (!parsed.success) {
        log.warn("archive_session.invalid_args", {
          issues: parsed.error.issues.length,
        });
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
      const sessionStartedAt = Date.now();
      log.info("archive_session.start", {
        cwd: parsed.data.cwd,
        session_id: parsed.data.session_id,
        intent: parsed.data.intent,
      });
      try {
        const transcriptPath = await locateClaudeSessionTranscript({
          cwd: parsed.data.cwd,
          ...(parsed.data.session_id
            ? { sessionId: parsed.data.session_id }
            : {}),
          ...(projectsRoot ? { projectsRoot } : {}),
        });
        const transcript = await parseTranscriptFile(transcriptPath);
        if (transcript.messages.length === 0) {
          log.warn("archive_session.empty_transcript", {
            transcript: transcriptPath,
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Transcript at ${transcriptPath} contains no messages.`,
              },
            ],
          };
        }
        const input = transcriptToArchiveInput(transcript, {
          ...(parsed.data.project ? { project: parsed.data.project } : {}),
          ...(parsed.data.topics ? { topics: parsed.data.topics } : {}),
          ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
        });
        if (parsed.data.intent) {
          input.intent = parsed.data.intent;
        }
        // skipDuplicates: re-issuing "archive" without new turns is a no-op
        // instead of a duplicate record.
        const result = await queue.enqueue(() =>
          archiveConversation({ config, db, sqlite }, input, {
            skipDuplicates: true,
          }),
        );
        log.info("archive_session.done", {
          conversation: result.conversation.id,
          transcript: transcriptPath,
          messages: transcript.messages.length,
          path: result.relativePath,
          job: result.extractJobId,
          committed: result.committed,
          skipped_duplicate: result.skippedDuplicate ?? false,
          duration_ms: Date.now() - sessionStartedAt,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  conversation_id: result.conversation.id,
                  transcript_path: transcriptPath,
                  message_count: transcript.messages.length,
                  path: result.relativePath,
                  extract_job_id: result.extractJobId,
                  committed: result.committed,
                  ...(result.skippedDuplicate
                    ? { skipped_duplicate: true }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        log.error("archive_session.fail", {
          cwd: parsed.data.cwd,
          error: (err as Error).message,
          duration_ms: Date.now() - sessionStartedAt,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `archive_session failed: ${(err as Error).message}`,
            },
          ],
        };
      }
    }

    if (request.params.name === ARCHIVE_ANSWER_TOOL_NAME) {
      const parsed = ArchiveAnswerInputSchema.safeParse(
        request.params.arguments,
      );
      if (!parsed.success) {
        log.warn("archive_answer.invalid_args", {
          issues: parsed.error.issues.length,
        });
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
      const answerStartedAt = Date.now();
      log.info("archive_answer.start", {
        source: parsed.data.source,
        model: parsed.data.model,
        intent: parsed.data.intent,
        has_question: Boolean(parsed.data.question?.trim()),
      });
      try {
        const input = archiveAnswerToArchiveInput(parsed.data);
        // skipDuplicates: re-issuing "archive this answer" for the same
        // answer is a no-op instead of a duplicate record.
        const result = await queue.enqueue(() =>
          archiveConversation({ config, db, sqlite }, input, {
            skipDuplicates: true,
          }),
        );
        log.info("archive_answer.done", {
          conversation: result.conversation.id,
          path: result.relativePath,
          job: result.extractJobId,
          committed: result.committed,
          skipped_duplicate: result.skippedDuplicate ?? false,
          duration_ms: Date.now() - answerStartedAt,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  conversation_id: result.conversation.id,
                  scope: ArchiveScope.Answer,
                  path: result.relativePath,
                  extract_job_id: result.extractJobId,
                  committed: result.committed,
                  ...(result.skippedDuplicate
                    ? { skipped_duplicate: true }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        log.error("archive_answer.fail", {
          source: parsed.data.source,
          error: (err as Error).message,
          duration_ms: Date.now() - answerStartedAt,
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `archive_answer failed: ${(err as Error).message}`,
            },
          ],
        };
      }
    }

    if (request.params.name !== ARCHIVE_TOOL_NAME) {
      log.warn("tool.unknown", { name: request.params.name });
      return {
        isError: true,
        content: [
          { type: "text", text: `Unknown tool: ${request.params.name}` },
        ],
      };
    }

    const parsed = ArchiveInputSchema.safeParse(request.params.arguments);
    if (!parsed.success) {
      log.warn("archive_conversation.invalid_args", {
        issues: parsed.error.issues.length,
      });
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

    const truncationError = detectTruncatedTranscript(parsed.data.messages);
    if (truncationError) {
      log.warn("archive_conversation.rejected_truncated", {
        source: parsed.data.source,
        messages: parsed.data.messages.length,
      });
      return {
        isError: true,
        content: [{ type: "text", text: truncationError }],
      };
    }

    // Server-enforced fidelity: never trust the caller's claim when the
    // transport says otherwise (ChatGPT consistently sends summarized
    // assistant turns while presenting them as the transcript).
    const input = deps.forcedFidelity
      ? { ...parsed.data, fidelity: deps.forcedFidelity }
      : parsed.data;

    const startedAt = Date.now();
    log.info("archive_conversation.start", {
      source: input.source,
      messages: input.messages.length,
      model: input.model,
      intent: input.intent,
      partial: input.partial ?? false,
      fidelity: input.fidelity ?? "verbatim",
    });
    try {
      const result = await queue.enqueue(() =>
        archiveConversation({ config, db, sqlite }, input),
      );

      log.info("archive_conversation.done", {
        conversation: result.conversation.id,
        path: result.relativePath,
        job: result.extractJobId,
        committed: result.committed,
        duration_ms: Date.now() - startedAt,
      });
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
      log.error("archive_conversation.fail", {
        source: parsed.data.source,
        error: (err as Error).message,
        duration_ms: Date.now() - startedAt,
      });
      return {
        isError: true,
        content: [
          { type: "text", text: `archive failed: ${(err as Error).message}` },
        ],
      };
    }
  });

  return server;
}
