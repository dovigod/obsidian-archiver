import { describe, expect, it } from "vitest";
import {
  matchBearerToken,
  resolveAuthTokens,
  tokenFingerprint,
} from "@core/mcp-auth";

const T1 = "a".repeat(32);
const T2 = "b".repeat(32);

describe("resolveAuthTokens", () => {
  it("disables auth via --no-auth or KH_MCP_NO_AUTH=1", () => {
    expect(resolveAuthTokens({}, ["--no-auth"])).toEqual({ disabled: true });
    expect(resolveAuthTokens({ KH_MCP_NO_AUTH: "1" }, [])).toEqual({
      disabled: true,
    });
  });

  it("accepts a single KH_MCP_TOKEN (back-compat)", () => {
    expect(resolveAuthTokens({ KH_MCP_TOKEN: T1 }, [])).toEqual({
      tokens: [T1],
    });
  });

  it("builds a whitelist from KH_MCP_TOKENS (comma / whitespace separated)", () => {
    expect(
      resolveAuthTokens({ KH_MCP_TOKENS: `${T1}, ${T2}` }, []),
    ).toEqual({ tokens: [T1, T2] });
    expect(
      resolveAuthTokens({ KH_MCP_TOKENS: `${T1}\n${T2}` }, []),
    ).toEqual({ tokens: [T1, T2] });
  });

  it("merges and de-duplicates KH_MCP_TOKEN + KH_MCP_TOKENS", () => {
    const result = resolveAuthTokens(
      { KH_MCP_TOKEN: T1, KH_MCP_TOKENS: `${T1},${T2}` },
      [],
    );
    expect(result).toEqual({ tokens: [T1, T2] });
  });

  it("errors when no token is configured", () => {
    const result = resolveAuthTokens({}, []);
    expect("error" in result).toBe(true);
  });

  it("rejects tokens shorter than the minimum length", () => {
    const result = resolveAuthTokens({ KH_MCP_TOKENS: `${T1},short` }, []);
    expect("error" in result).toBe(true);
  });
});

describe("matchBearerToken", () => {
  const tokens = [T1, T2];

  it("matches any allow-listed token", () => {
    expect(matchBearerToken(`Bearer ${T1}`, tokens)).toBe(T1);
    expect(matchBearerToken(`Bearer ${T2}`, tokens)).toBe(T2);
  });

  it("rejects unknown tokens, missing/malformed headers", () => {
    expect(matchBearerToken(`Bearer ${"c".repeat(32)}`, tokens)).toBeNull();
    expect(matchBearerToken(undefined, tokens)).toBeNull();
    expect(matchBearerToken(T1, tokens)).toBeNull(); // no "Bearer " prefix
    expect(matchBearerToken("Bearer ", tokens)).toBeNull();
  });
});

describe("tokenFingerprint", () => {
  it("is stable, short, and does not leak the token", () => {
    const fp = tokenFingerprint(T1);
    expect(fp).toHaveLength(8);
    expect(fp).toBe(tokenFingerprint(T1));
    expect(fp).not.toContain(T1.slice(0, 8));
    expect(tokenFingerprint(T2)).not.toBe(fp);
  });
});
