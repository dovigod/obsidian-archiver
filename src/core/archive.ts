import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "@core/config";
import type { DB } from "@core/db/client";
import { ConversationsRepository } from "@core/db/repository/conversations";
import { JobsRepository } from "@core/db/repository/jobs";
import type { SqliteHandle } from "@core/db/client";
import { autoCommit } from "@core/git";
import { newId } from "@core/ids";
import { normalizeArchiveInput } from "@core/normalize";
import { MarkdownVaultRepository } from "@core/repository/raw";
import type { ArchiveInput, Conversation, Message } from "@core/schema";

export interface ArchiveResult {
  conversation: Conversation;
  /** Absolute path to the markdown file. */
  absolutePath: string;
  /** Path relative to the vault root. */
  relativePath: string;
  /** Job id of the queued extract job. */
  extractJobId: string;
  committed: boolean;
  /** sha256 of normalized messages — used for backfill idempotency. */
  contentHash: string;
  /**
   * True when the input matched an existing conversation by `contentHash`
   * and the archive was skipped. When set, all other fields reference the
   * pre-existing row (no new file written, no job enqueued).
   */
  skippedDuplicate?: boolean;
}

/** Stable hash over normalized messages: role + content only, message order preserved. */
export function computeContentHash(messages: readonly Message[]): string {
  const h = createHash("sha256");
  for (const m of messages) {
    h.update(m.role);
    h.update("");
    h.update(m.content);
    h.update("");
  }
  return h.digest("hex");
}

export interface ArchiveDeps {
  config: Config;
  db: DB;
  sqlite: SqliteHandle;
}

/**
 * Stage 1 entry point: validate + normalize the input, write raw md to
 * `vault/raw/conversations/YYYY/MM/{id}.md`, insert a `conversations` row,
 * and enqueue a Stage 2 `extract` job. Optionally git-commits the raw md.
 *
 * Called by both the MCP `archive_conversation` tool and the
 * `archive-transcript` CLI subcommand.
 */
export interface ArchiveOptions {
  /**
   * When true, the archive returns early with `skippedDuplicate: true` if a
   * conversation with the same `contentHash` already exists. Used by the
   * backfill scraper to keep re-runs idempotent.
   */
  skipDuplicates?: boolean;
}

export async function archiveConversation(
  deps: ArchiveDeps,
  input: ArchiveInput,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const conversation = normalizeArchiveInput(input);
  const contentHash = computeContentHash(conversation.messages);
  const conversationsRepo = new ConversationsRepository(deps.db);

  if (options.skipDuplicates) {
    const existing = conversationsRepo.findByContentHash(contentHash);
    if (existing) {
      return {
        conversation: {
          ...conversation,
          id: existing.id,
        },
        absolutePath: join(deps.config.vault.path, existing.rawPath),
        relativePath: existing.rawPath,
        extractJobId: "",
        committed: false,
        contentHash,
        skippedDuplicate: true,
      };
    }
  }

  const repo = new MarkdownVaultRepository(deps.config.vault.path);
  const { absolutePath, relativePath } = await repo.writeConversation(
    conversation,
  );

  conversationsRepo.create({
    id: conversation.id,
    source: conversation.source,
    model: conversation.model,
    createdAt: Date.parse(conversation.created_at),
    project: conversation.project,
    topics: conversation.topics,
    conversationType: conversation.conversation_type,
    tags: conversation.tags,
    git: conversation.git,
    cwd: conversation.cwd,
    rawPath: relativePath,
    contentHash,
  });

  const jobsRepo = new JobsRepository(deps.db, deps.sqlite);
  const extractJobId = jobsRepo.enqueue({
    id: newId(),
    type: "extract",
    payload: {
      conversation_id: conversation.id,
      conversation_path: relativePath,
    },
  });

  let committed = false;
  if (deps.config.git.auto_commit) {
    committed = await autoCommit({
      vaultPath: deps.config.vault.path,
      files: [join(deps.config.vault.path, relativePath)],
      message: `archive(raw): ${conversation.source} ${conversation.id}`,
    });
  }

  return {
    conversation,
    absolutePath,
    relativePath,
    extractJobId,
    committed,
    contentHash,
  };
}
