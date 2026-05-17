import type { Config } from "@core/config";
import { MockEmbeddingsProvider } from "@core/embeddings/mock";
import { OpenAIEmbeddingsProvider } from "@core/embeddings/openai";
import type { EmbeddingsProvider } from "@core/embeddings/provider";

/**
 * Build an EmbeddingsProvider from the runtime config. Returns null when
 * embeddings are disabled, or when the configured provider requires an env
 * var that isn't set (graceful degrade — never blocks the main pipeline).
 */
export function buildEmbeddingsProvider(
  config: Config,
): EmbeddingsProvider | null {
  const cfg = config.dedup.fuzzy.embeddings;
  if (!cfg.enabled) {return null;}

  if (cfg.provider === "mock") {
    return new MockEmbeddingsProvider();
  }
  if (cfg.provider === "openai") {
    const apiKey = process.env[cfg.api_key_env];
    if (!apiKey) {
      process.stderr.write(
        `[dedup] embeddings enabled but ${cfg.api_key_env} is unset; falling back to FTS5 only\n`,
      );
      return null;
    }
    return new OpenAIEmbeddingsProvider({ apiKey, model: cfg.model });
  }
  return null;
}
