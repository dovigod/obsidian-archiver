import type { Config } from "@core/config";
import { EntitiesRepository } from "@core/db/repository/entities";
import { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import type { DB } from "@core/db/client";
import type { LLMProvider } from "@core/llm/provider";
import { autoCommit } from "@core/git";
import { dedupEntity } from "@core/pipeline/dedup";
import { executeDecision, type ExecuteResult } from "@core/pipeline/execute";
import { extractEntities } from "@core/pipeline/extract";
import { renderDirty } from "@core/pipeline/render";
import { MarkdownVaultRepository } from "@core/repository/raw";

export interface RunPipelineInput {
  conversationId: string;
  /** Vault-relative path to the raw conversation .md. */
  conversationPath: string;
}

export interface RunPipelineResult {
  conversationId: string;
  entities: ExecuteResult[];
  rendered: { written: string[]; deleted: string[]; driftStaged: string[] };
}

/**
 * Stage 2 orchestration for one conversation:
 *
 *   1. read raw conversation md
 *   2. extract entity candidates (LLM)
 *   3. for each candidate: dedup → execute (insert new OR rewrite existing)
 *   4. render any dirty entity md (eager mode)
 *   5. git auto-commit per render (config-gated)
 */
export async function runStage2Pipeline(
  config: Config,
  db: DB,
  llm: LLMProvider,
  input: RunPipelineInput,
): Promise<RunPipelineResult> {
  const raw = new MarkdownVaultRepository(config.vault.path);
  const conversation = await raw.readConversation(input.conversationPath);

  const candidates = await extractEntities(llm, conversation);
  if (candidates.length === 0) {
    return {
      conversationId: input.conversationId,
      entities: [],
      rendered: { written: [], deleted: [], driftStaged: [] },
    };
  }

  const entitiesRepo = new EntitiesRepository(db);
  const renderedRepo = new RenderedFilesRepository(db);
  const results: ExecuteResult[] = [];

  for (const candidate of candidates) {
    const dedup = await dedupEntity(llm, entitiesRepo, candidate, {
      topK: config.dedup.fuzzy.top_k,
      minScore: config.dedup.fuzzy.min_score,
      llmConfirm: config.dedup.fuzzy.llm_confirm,
    });
    const result = await executeDecision({
      config,
      llm,
      entitiesRepo,
      conversation,
      candidate,
      dedup,
    });
    results.push(result);
  }

  let rendered = { written: [] as string[], deleted: [] as string[], driftStaged: [] as string[] };
  if (config.sync.mode === "auto" && config.sync.auto.strategy === "eager") {
    rendered = await renderDirty(config.vault.path, entitiesRepo, renderedRepo, {
      detectDrift: config.sync.drift.detect,
    });

    if (config.git.auto_commit && rendered.written.length + rendered.deleted.length > 0) {
      const files = [...rendered.written, ...rendered.deleted].map(
        (rel) => `${config.vault.path}/${rel}`,
      );
      await autoCommit({
        vaultPath: config.vault.path,
        files,
        message: `sync: +${rendered.written.length} -${rendered.deleted.length}`,
      });
    }
  }

  return {
    conversationId: input.conversationId,
    entities: results,
    rendered,
  };
}
