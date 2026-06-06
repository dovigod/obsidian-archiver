import { LLMProvider } from "@constants/llm-provider";
import type { Config } from "@core/config";
import { assertGitPushEnv } from "@core/git";

/**
 * Validate required environment variables at server startup. THROWS on the
 * first missing var so a misconfigured server fails fast instead of only
 * discovering the problem on the first archive/push.
 *
 * Checks, gated on config:
 *   - git auto-push → `KH_GIT_REMOTE_URL` (+ token for https) must be set.
 *   - extract LLM in API-key mode (`provider = "claude"`) → the configured
 *     API-key env var must be set. Subscription mode (`claude-cli`) needs no
 *     key, so it is skipped entirely.
 */
export function assertRuntimeEnv(config: Config): void {
  assertGitPushEnv(config.git.auto_push);

  const { provider, api_key_env } = config.extract.llm;
  // Only the Anthropic-API provider needs a key. claude-cli (subscription)
  // and any non-API provider are not key-gated here.
  if (provider === LLMProvider.Claude && !process.env[api_key_env]) {
    throw new Error(
      `extract.llm.provider is "claude" (API-key mode) but ${api_key_env} ` +
        `is not set. Export ${api_key_env} (e.g. in .env), or switch to ` +
        `subscription auth with extract.llm.provider = "claude-cli".`,
    );
  }
}
