import { join } from "node:path";
import type { Config } from "@core/config";
import { autoCommit } from "@core/git";
import { normalizeArchiveInput } from "@core/normalize";
import { MarkdownVaultRepository } from "@core/repository/raw";
import type { ArchiveInput, Conversation } from "@core/schema";

export interface ArchiveResult {
  conversation: Conversation;
  /** Absolute path to the markdown file. */
  absolutePath: string;
  /** Path relative to the vault root. */
  relativePath: string;
  committed: boolean;
}

/**
 * Stage 1 entry point: validate, normalize, write to vault, optionally commit.
 * Used by both the MCP `archive_conversation` tool and the `archive-transcript` CLI.
 */
export async function archiveConversation(
  config: Config,
  input: ArchiveInput,
): Promise<ArchiveResult> {
  const conversation = normalizeArchiveInput(input);
  const repo = new MarkdownVaultRepository(config.vault.path);
  const { absolutePath, relativePath } = await repo.writeConversation(
    conversation,
  );

  let committed = false;
  if (config.git.auto_commit) {
    committed = await autoCommit({
      vaultPath: config.vault.path,
      files: [join(config.vault.path, relativePath)],
      message: `archive(raw): ${conversation.source} ${conversation.id}`,
    });
  }

  return { conversation, absolutePath, relativePath, committed };
}
