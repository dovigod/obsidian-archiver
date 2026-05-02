import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deepMerge, loadConfig } from "@core/config";
import { testTmpDir } from "./helpers";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    const out = deepMerge(
      { a: 1, nested: { x: 1, y: 2 } },
      { nested: { y: 99, z: 3 } },
    );
    assert.deepEqual(out, { a: 1, nested: { x: 1, y: 99, z: 3 } });
  });

  it("override wins for primitives and arrays", () => {
    const out = deepMerge({ list: [1, 2, 3], n: 1 }, { list: [9], n: 2 });
    assert.deepEqual(out, { list: [9], n: 2 });
  });
});

describe("loadConfig", () => {
  it("applies defaults when only vault.path is provided", () => {
    const dir = mkdtempSync(join(testTmpDir(), "cfg-defaults-"));
    mkdirSync(join(dir, ".knowledge-hub"));
    writeFileSync(
      join(dir, ".knowledge-hub", "config.json"),
      JSON.stringify({ vault: { path: join(dir, "vault") } }),
    );

    const cfg = loadConfig({ projectRoot: dir, skipGlobal: true });
    assert.equal(cfg.vault.path, join(dir, "vault"));
    assert.equal(cfg.capture.mode, "auto");
    assert.equal(cfg.classification.llm.provider, "claude");
    assert.equal(cfg.git.auto_commit, true);
  });

  it("project config overrides global", () => {
    const dir = mkdtempSync(join(testTmpDir(), "cfg-overrides-"));
    mkdirSync(join(dir, ".knowledge-hub"));
    writeFileSync(
      join(dir, ".knowledge-hub", "config.json"),
      JSON.stringify({ capture: { mode: "manual" } }),
    );

    const cfg = loadConfig({
      projectRoot: dir,
      skipGlobal: true,
      overrides: { vault: { path: join(dir, "vault") } },
    });
    assert.equal(cfg.capture.mode, "manual");
    assert.equal(cfg.vault.path, join(dir, "vault"));
  });

  it("rejects missing vault.path", () => {
    const dir = mkdtempSync(join(testTmpDir(), "cfg-reject-no-vault-"));
    assert.throws(
      () => loadConfig({ projectRoot: dir, skipGlobal: true }),
      /Invalid knowledge-hub config/,
    );
  });
});
