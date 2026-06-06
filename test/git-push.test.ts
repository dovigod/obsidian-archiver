import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertGitPushEnv,
  autoCommit,
  injectTokenIntoRemoteUrl,
  pushVault,
  resolvePushRemoteUrl,
  resolvePushToken,
} from "@core/git";
import { prepareVaultRepo, testTmpDir } from "./helpers";

describe("injectTokenIntoRemoteUrl", () => {
  it("injects an x-access-token credential into https URLs", () => {
    expect(
      injectTokenIntoRemoteUrl("https://github.com/you/vault.git", "ghp_abc"),
    ).toBe("https://x-access-token:ghp_abc@github.com/you/vault.git");
  });

  it("URL-encodes the token", () => {
    expect(
      injectTokenIntoRemoteUrl("https://github.com/you/vault.git", "a/b@c"),
    ).toBe("https://x-access-token:a%2Fb%40c@github.com/you/vault.git");
  });

  it("returns null for SSH remotes (keys handle auth)", () => {
    expect(
      injectTokenIntoRemoteUrl("git@github.com:you/vault.git", "ghp_abc"),
    ).toBeNull();
  });
});

describe("resolvePushToken / resolvePushRemoteUrl (env-based)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the token from KH_GIT_TOKEN first", () => {
    vi.stubEnv("KH_GIT_TOKEN", "kh-token");
    vi.stubEnv("GITHUB_TOKEN", "gh-token");
    expect(resolvePushToken()).toBe("kh-token");
  });

  it("falls back to GITHUB_TOKEN", () => {
    vi.stubEnv("KH_GIT_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "gh-token");
    expect(resolvePushToken()).toBe("gh-token");
  });

  it("returns undefined when no token env is set", () => {
    vi.stubEnv("KH_GIT_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(resolvePushToken()).toBeUndefined();
  });

  it("reads the remote URL from KH_GIT_REMOTE_URL", () => {
    vi.stubEnv("KH_GIT_REMOTE_URL", "https://github.com/you/vault.git");
    expect(resolvePushRemoteUrl()).toBe("https://github.com/you/vault.git");
  });
});

describe("assertGitPushEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a no-op when auto-push is disabled", () => {
    expect(() => assertGitPushEnv(false)).not.toThrow();
  });

  it("throws when auto-push is on but KH_GIT_REMOTE_URL is unset", () => {
    vi.stubEnv("KH_GIT_REMOTE_URL", "");
    expect(() => assertGitPushEnv(true)).toThrow(/KH_GIT_REMOTE_URL/);
  });

  it("throws for an https remote without a token", () => {
    vi.stubEnv("KH_GIT_REMOTE_URL", "https://github.com/you/vault.git");
    vi.stubEnv("KH_GIT_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(() => assertGitPushEnv(true)).toThrow(/token/);
  });

  it("passes for an https remote with a token", () => {
    vi.stubEnv("KH_GIT_REMOTE_URL", "https://github.com/you/vault.git");
    vi.stubEnv("KH_GIT_TOKEN", "ghp_abc123456789");
    expect(() => assertGitPushEnv(true)).not.toThrow();
  });

  it("passes for an SSH remote without a token", () => {
    vi.stubEnv("KH_GIT_REMOTE_URL", "git@github.com:you/vault.git");
    vi.stubEnv("KH_GIT_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(() => assertGitPushEnv(true)).not.toThrow();
  });
});

describe("pushVault", () => {
  async function setupVaultWithBareRemote(): Promise<{
    vault: string;
    bare: string;
  }> {
    const dir = mkdtempSync(join(testTmpDir(), "push-"));
    const bare = join(dir, "remote.git");
    mkdirSync(bare, { recursive: true });
    await simpleGit({ baseDir: bare }).init(true);

    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    await simpleGit({ baseDir: vault }).addRemote("origin", bare);

    writeFileSync(join(vault, "note.md"), "hello\n");
    const committed = await autoCommit({
      vaultPath: vault,
      files: [join(vault, "note.md")],
      message: "test: note",
    });
    expect(committed).toBe(true);
    return { vault, bare };
  }

  it("pushes the current branch to the configured remote", async () => {
    const { vault, bare } = await setupVaultWithBareRemote();

    const pushed = await pushVault({ vaultPath: vault });
    expect(pushed).toBe(true);

    const log = await simpleGit({ baseDir: bare }).log();
    expect(log.latest?.message).toBe("test: note");
  });

  it("returns false (no throw) when the remote is missing", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "push-noremote-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    writeFileSync(join(vault, "note.md"), "hi\n");
    await autoCommit({
      vaultPath: vault,
      files: [join(vault, "note.md")],
      message: "test: note",
    });

    const pushed = await pushVault({ vaultPath: vault });
    expect(pushed).toBe(false);
  });

  it("returns false (no throw) when the push itself fails", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "push-badremote-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    await simpleGit({ baseDir: vault }).addRemote(
      "origin",
      join(dir, "does-not-exist.git"),
    );
    writeFileSync(join(vault, "note.md"), "hi\n");
    await autoCommit({
      vaultPath: vault,
      files: [join(vault, "note.md")],
      message: "test: note",
    });

    const pushed = await pushVault({ vaultPath: vault });
    expect(pushed).toBe(false);
  });
});
