import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@core/config";
import { SetupAbortedError, interactiveSetup } from "@core/setup";
import { prepareVaultRepo, testTmpDir } from "./helpers";

describe("interactiveSetup (project scope, hermetic)", () => {
  it("writes project config + initializes vault when given answers", async () => {
    const cwd = mkdtempSync(join(testTmpDir(), "setup-project-"));
    const vault = join(cwd, "vault");
    // Pre-prepare git so initVault doesn't trip on missing user.email/name on
    // CI machines without a global git identity (mirrors init.test.ts).
    await prepareVaultRepo(vault);

    const result = await interactiveSetup({
      cwd,
      answers: { scope: "project", vaultPath: vault, overwrite: false },
    });

    const expectedConfig = join(cwd, ".knowledge-hub", "config.json");
    expect(result.configPath).toBe(expectedConfig);
    expect(result.scope).toBe("project");
    expect(result.vaultPath).toBe(vault);
    expect(existsSync(expectedConfig)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedConfig, "utf8"));
    expect(parsed).toEqual({ vault: { path: vault } });

    // Vault scaffolded
    expect(existsSync(join(vault, ".kh.db"))).toBe(true);
    expect(existsSync(join(vault, "knowledge"))).toBe(true);
    expect(existsSync(join(vault, ".gitignore"))).toBe(true);
  });

  it("loadConfig({ projectRoot }) returns a valid config after setup", async () => {
    const cwd = mkdtempSync(join(testTmpDir(), "setup-roundtrip-"));
    const vault = join(cwd, "vault");
    await prepareVaultRepo(vault);

    await interactiveSetup({
      cwd,
      answers: { scope: "project", vaultPath: vault, overwrite: false },
    });

    const config = loadConfig({ projectRoot: cwd, skipGlobal: true });
    expect(config.vault.path).toBe(vault);
    // Defaults applied from zod schema
    expect(config.storage.sqlite.path).toBe(".kh.db");
    expect(config.storage.sqlite.journal_mode).toBe("WAL");
  });

  it("refuses to overwrite existing config when overwrite=false", async () => {
    const cwd = mkdtempSync(join(testTmpDir(), "setup-noclobber-"));
    const vault = join(cwd, "vault");
    await prepareVaultRepo(vault);
    const configPath = join(cwd, ".knowledge-hub", "config.json");
    mkdirSync(join(cwd, ".knowledge-hub"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ vault: { path: "/other" } }));

    await expect(
      interactiveSetup({
        cwd,
        answers: { scope: "project", vaultPath: vault, overwrite: false },
      }),
    ).rejects.toBeInstanceOf(SetupAbortedError);

    // Original untouched
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      vault: { path: "/other" },
    });
  });

  it("overwrites existing config when overwrite=true", async () => {
    const cwd = mkdtempSync(join(testTmpDir(), "setup-force-"));
    const vault = join(cwd, "vault");
    await prepareVaultRepo(vault);
    const configPath = join(cwd, ".knowledge-hub", "config.json");
    mkdirSync(join(cwd, ".knowledge-hub"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ vault: { path: "/other" } }));

    const result = await interactiveSetup({
      cwd,
      answers: { scope: "project", vaultPath: vault, overwrite: true },
    });

    expect(result.configPath).toBe(configPath);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      vault: { path: vault },
    });
  });

});

describe("loadConfig error guidance", () => {
  it("includes the `kh setup` hint when no config files are found", () => {
    const cwd = mkdtempSync(join(testTmpDir(), "loadconfig-firstrun-"));
    let err: Error | undefined;
    try {
      loadConfig({ projectRoot: cwd, skipGlobal: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/No config file was found/);
    expect(err!.message).toMatch(/kh setup/);
  });

  it("does NOT include the `kh setup` hint when a config exists but is malformed", () => {
    const cwd = mkdtempSync(join(testTmpDir(), "loadconfig-malformed-"));
    mkdirSync(join(cwd, ".knowledge-hub"), { recursive: true });
    // Valid JSON, but missing required vault.path
    writeFileSync(
      join(cwd, ".knowledge-hub", "config.json"),
      JSON.stringify({ extract: {} }),
    );
    let err: Error | undefined;
    try {
      loadConfig({ projectRoot: cwd, skipGlobal: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/Invalid knowledge-hub config/);
    expect(err!.message).not.toMatch(/No config file was found/);
  });
});
