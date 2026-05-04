import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { type Config, loadConfig } from "@core/config";
import { ClaudeProvider } from "@core/llm/claude";
import type { LLMProvider } from "@core/llm/provider";
import { runStage2Pipeline } from "@core/pipeline/run";
import { FsQueue, type JobRecord } from "@core/queue/fs-queue";

export interface RunWorkerOptions {
  pollIntervalMs?: number;
  /** Stop after one drain cycle (used for tests / one-shot CI runs). */
  once?: boolean;
  /** Inject an LLM (for tests). When omitted, builds a Claude provider from config. */
  llm?: LLMProvider;
  /** Inject a config (for tests). When omitted, loads from disk. */
  config?: Config;
}

export async function runWorker(opts: RunWorkerOptions = {}): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const config = opts.config ?? loadConfig();
  const queue = new FsQueue(join(config.vault.path, "_queue"));
  const llm = opts.llm ?? buildLLMFromConfig(config);

  let stop = false;
  const onSig = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    while (!stop) {
      const job = await queue.claim();
      if (!job) {
        if (opts.once) {
          return;
        }
        await delay(pollIntervalMs);
        continue;
      }
      await processJob(queue, job, config, llm);
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

async function processJob(
  queue: FsQueue,
  job: JobRecord,
  config: Config,
  llm: LLMProvider,
): Promise<void> {
  try {
    if (job.type === "classify") {
      await runStage2Pipeline(config, llm, {
        conversationId: String(job.payload.conversation_id),
        conversationPath: String(job.payload.conversation_path),
      });
      await queue.complete(job.id);
    } else {
      throw new Error(`unknown job type: ${job.type}`);
    }
  } catch (err) {
    await queue.fail(job.id, (err as Error).message);
    process.stderr.write(
      `[knowledge-hub] job ${job.id} failed: ${(err as Error).message}\n`,
    );
  }
}

function buildLLMFromConfig(config: Config): LLMProvider {
  const apiKeyEnv = config.classification.llm.api_key_env;
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing API key: env var ${apiKeyEnv} is not set`);
  }
  return new ClaudeProvider({
    apiKey,
    model: config.classification.llm.model,
  });
}
