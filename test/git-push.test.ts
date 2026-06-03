import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoCommit,
  injectTokenIntoRemoteUrl,
  pushVault,
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

describe("resolvePushToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the explicit config token over the env var", () => {
    vi.stubEnv("KH_TEST_GH_TOKEN", "from-env");
    expect(
      resolvePushToken({ token: "from-config", token_env: "KH_TEST_GH_TOKEN" }),
    ).toBe("from-config");
  });

  it("falls back to the named env var", () => {
    vi.stubEnv("KH_TEST_GH_TOKEN", "from-env");
    expect(resolvePushToken({ token_env: "KH_TEST_GH_TOKEN" })).toBe(
      "from-env",
    );
  });

  it("returns undefined when neither is set", () => {
    expect(resolvePushToken({ token_env: "KH_TEST_GH_TOKEN_UNSET" })).toBe(
      undefined,
    );
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
