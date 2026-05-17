import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { type Config, loadConfig } from "@core/config";
import { createDb, type DB, type SqliteHandle } from "@core/db/client";
import { JobsRepository, type ClaimedJob } from "@core/db/repository/jobs";
import { ClaudeProvider } from "@core/llm/claude";
import { ClaudeCliProvider } from "@core/llm/claude-cli";
import type { LLMProvider } from "@core/llm/provider";
import { runStage2Pipeline } from "@core/pipeline/run";

export interface RunWorkerOptions {
  pollIntervalMs?: number;
  /** Stop after one drain cycle (used for tests / one-shot CI runs). */
  once?: boolean;
  /** Inject an LLM (for tests). When omitted, builds a Claude provider from config. */
  llm?: LLMProvider;
  /** Inject a config (for tests). When omitted, loads from disk. */
  config?: Config;
  /** Inject a pre-opened DB (for tests). When omitted, opens from config + migrates. */
  db?: DB;
  /** Companion sqlite handle when `db` is injected. */
  sqlite?: SqliteHandle;
}

export async function runWorker(opts: RunWorkerOptions = {}): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const config = opts.config ?? loadConfig();
  let ownsDb = false;
  let db: DB;
  let sqlite: SqliteHandle;
  if (opts.db && opts.sqlite) {
    db = opts.db;
    sqlite = opts.sqlite;
  } else {
    const opened = createDb({
      path: join(config.vault.path, config.storage.sqlite.path),
      migrate: true,
    });
    db = opened.db;
    sqlite = opened.sqlite;
    ownsDb = true;
  }
  const llm = opts.llm ?? buildLLMFromConfig(config);
  const jobsRepo = new JobsRepository(db, sqlite);

  jobsRepo.reclaimStuck();

  let stop = false;
  const onSig = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    while (!stop) {
      const job = jobsRepo.claim();
      if (!job) {
        if (opts.once) {
          return;
        }
        await delay(pollIntervalMs);
        continue;
      }
      await processJob(jobsRepo, db, job, config, llm);
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    if (ownsDb) {
      sqlite.close();
    }
  }
}

async function processJob(
  jobsRepo: JobsRepository,
  db: DB,
  job: ClaimedJob,
  config: Config,
  llm: LLMProvider,
): Promise<void> {
  try {
    if (job.type === "extract") {
      await runStage2Pipeline(config, db, llm, {
        conversationId: String(job.payload.conversation_id),
        conversationPath: String(job.payload.conversation_path),
      });
      jobsRepo.complete(job.id);
    } else {
      throw new Error(`unknown job type: ${job.type}`);
    }
  } catch (err) {
    jobsRepo.fail(job.id, (err as Error).message);
    process.stderr.write(
      `[knowledge-hub] job ${job.id} failed: ${(err as Error).message}\n`,
    );
  }
}

function buildLLMFromConfig(config: Config): LLMProvider {
  const { provider, model } = config.extract.llm;

  if (provider === "claude-cli") {
    return new ClaudeCliProvider({
      ...(model ? { model } : {}),
    });
  }

  if (provider === "claude") {
    const apiKeyEnv = config.extract.llm.api_key_env;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing API key: env var ${apiKeyEnv} is not set`);
    }
    return new ClaudeProvider({ apiKey, model });
  }

  throw new Error(
    `Unsupported LLM provider "${provider}". Use "claude" or "claude-cli".`,
  );
}
