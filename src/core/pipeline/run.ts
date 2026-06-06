import type { Config } from "@core/config";
import { DedupEmbeddingsRepository } from "@core/db/repository/dedup_embeddings";
import { EntitiesRepository } from "@core/db/repository/entities";
import { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import type { DB } from "@core/db/client";
import { buildEmbeddingsProvider } from "@core/embeddings/factory";
import type { EmbeddingsProvider } from "@core/embeddings/provider";
import type { LLMProvider } from "@core/llm/provider";
import {
  autoCommit,
  pushVault,
  resolvePushRemoteUrl,
  resolvePushToken,
} from "@core/git";
import { dedupEntity, type EmbeddingsDedupOptions } from "@core/pipeline/dedup";
import { executeDecision, type ExecuteResult } from "@core/pipeline/execute";
import { extractEntities } from "@core/pipeline/extract";
import { renderDirty } from "@core/pipeline/render";
import { MarkdownVaultRepository } from "@core/repository/raw";

export interface RunPipelineInput {
  conversationId: string;
  /** Vault-relative path to the raw conversation .md. */
  conversationPath: string;
}

export interface RunPipelineOptions {
  /** Inject an embeddings provider; bypasses the config-driven factory. */
  embeddingsProvider?: EmbeddingsProvider | null;
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
 *   4. (Stage 5) upsert embedding row for the touched entity
 *   5. render any dirty entity md (eager mode)
 *   6. git auto-commit per render (config-gated)
 */
export async function runStage2Pipeline(
  config: Config,
  db: DB,
  llm: LLMProvider,
  input: RunPipelineInput,
  options: RunPipelineOptions = {},
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
  const dedupEmbeddingsRepo = new DedupEmbeddingsRepository(db);
  const embeddingsProvider =
    options.embeddingsProvider !== undefined
      ? options.embeddingsProvider
      : buildEmbeddingsProvider(config);
  const embeddingsOpt: EmbeddingsDedupOptions | undefined = embeddingsProvider
    ? {
        provider: embeddingsProvider,
        repo: dedupEmbeddingsRepo,
        topK: config.dedup.fuzzy.embeddings.top_k,
        minCosine: config.dedup.fuzzy.embeddings.min_cosine,
      }
    : undefined;
  const results: ExecuteResult[] = [];

  for (const candidate of candidates) {
    const dedup = await dedupEntity(llm, entitiesRepo, candidate, {
      topK: config.dedup.fuzzy.top_k,
      minScore: config.dedup.fuzzy.min_score,
      llmConfirm: config.dedup.fuzzy.llm_confirm,
      ...(embeddingsOpt ? { embeddings: embeddingsOpt } : {}),
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

    if (embeddingsProvider) {
      try {
        const ent = entitiesRepo.findById(result.entityId);
        if (ent) {
          const aliases = entitiesRepo.listAliases(ent.id);
          const text = [ent.name, ent.summary, ...aliases]
            .filter(Boolean)
            .join(" ")
            .trim();
          if (text.length > 0) {
            const vec = await embeddingsProvider.embed(text);
            dedupEmbeddingsRepo.upsert({
              entityId: ent.id,
              vector: vec,
              model: embeddingsProvider.model,
            });
          }
        }
      } catch (err) {
        process.stderr.write(
          `[dedup] embed-after-execute failed for ${result.entityId}: ${(err as Error).message}\n`,
        );
      }
    }
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
      // Entity names in the subject so `git log` shows what knowledge changed.
      const names = rendered.written
        .map((rel) => rel.replace(/^.*\//, "").replace(/\.md$/, "").replace(/_/g, " "))
        .join(", ");
      const subject = names.length > 0 ? names : "(deletes only)";
      const committed = await autoCommit({
        vaultPath: config.vault.path,
        files,
        message:
          `sync: ${subject.length > 60 ? `${subject.slice(0, 59)}…` : subject} ` +
          `(+${rendered.written.length} -${rendered.deleted.length})`,
      });
      if (committed && config.git.auto_push) {
        const token = resolvePushToken();
        const remoteUrl = resolvePushRemoteUrl();
        await pushVault({
          vaultPath: config.vault.path,
          remote: config.git.push.remote,
          branch: config.git.push.branch,
          ...(remoteUrl ? { remoteUrl } : {}),
          ...(token ? { token } : {}),
        });
      }
    }
  }

  return {
    conversationId: input.conversationId,
    entities: results,
    rendered,
  };
}
