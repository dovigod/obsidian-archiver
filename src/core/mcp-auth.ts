import { createHash, timingSafeEqual } from "node:crypto";

/** Minimum length for any accepted bearer token. */
export const MIN_TOKEN_LENGTH = 16;

export type AuthResult =
  | { disabled: true }
  | { error: string }
  | { tokens: readonly string[] };

/**
 * Build the bearer-token allow-list for the HTTP MCP server from env + argv.
 *
 * Sources (merged, de-duplicated):
 *   - `KH_MCP_TOKEN`  — single token (back-compat)
 *   - `KH_MCP_TOKENS` — whitelist; comma / whitespace / newline separated
 *
 * `--no-auth` (argv) or `KH_MCP_NO_AUTH=1` disables auth entirely. With auth
 * enabled, at least one token is required and every token must be at least
 * {@link MIN_TOKEN_LENGTH} chars — short tokens are rejected as a footgun.
 */
export function resolveAuthTokens(
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = [],
): AuthResult {
  if (argv.includes("--no-auth") || env.KH_MCP_NO_AUTH === "1") {
    return { disabled: true };
  }
  const raw = [
    ...(env.KH_MCP_TOKEN ? [env.KH_MCP_TOKEN] : []),
    ...(env.KH_MCP_TOKENS ? env.KH_MCP_TOKENS.split(/[\s,]+/) : []),
  ];
  const seen = new Set<string>();
  for (const entry of raw) {
    const token = entry.trim();
    if (token.length > 0) {
      seen.add(token);
    }
  }
  const tokens = [...seen];
  if (tokens.length === 0) {
    return {
      error:
        "no bearer token configured. Set KH_MCP_TOKEN=<token> for a single " +
        "token, or KH_MCP_TOKENS=<t1,t2,...> for an allow-list.",
    };
  }
  const tooShort = tokens.filter((t) => t.length < MIN_TOKEN_LENGTH);
  if (tooShort.length > 0) {
    return {
      error: `every token must be at least ${MIN_TOKEN_LENGTH} characters; ${tooShort.length} configured token(s) are shorter.`,
    };
  }
  return { tokens };
}

/** Constant-time-ish equality that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Return the allow-listed token matching `Authorization: Bearer <token>`, or
 * null when the header is missing/malformed or no token matches. Every token
 * is compared (no early return) to keep timing uniform across the list.
 */
export function matchBearerToken(
  authorizationHeader: string | undefined,
  tokens: readonly string[],
): string | null {
  if (!authorizationHeader) {
    return null;
  }
  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) {
    return null;
  }
  const presented = authorizationHeader.slice(prefix.length).trim();
  let matched: string | null = null;
  for (const token of tokens) {
    if (safeEqual(presented, token)) {
      matched = token;
    }
  }
  return matched;
}

/**
 * Short, non-reversible label for a token so request logs can distinguish
 * which allow-listed client connected without ever printing the secret.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}
