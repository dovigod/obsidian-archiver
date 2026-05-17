import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deepMerge, loadConfig } from "@core/config";
import { testTmpDir } from "./helpers";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    const out = deepMerge(
      { a: 1, nested: { x: 1, y: 2 } },
      { nested: { y: 99, z: 3 } },
    );
    expect(out).toEqual({ a: 1, nested: { x: 1, y: 99, z: 3 } });
  });

  it("override wins for primitives and arrays", () => {
    const out = deepMerge({ list: [1, 2, 3], n: 1 }, { list: [9], n: 2 });
    expect(out).toEqual({ list: [9], n: 2 });
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
    expect(cfg.vault.path).toBe(join(dir, "vault"));
    expect(cfg.capture.mode).toBe("auto");
    expect(cfg.extract.llm.provider).toBe("claude");
    expect(cfg.storage.sqlite.path).toBe(".kh.db");
    expect(cfg.storage.sqlite.journal_mode).toBe("WAL");
    expect(cfg.dedup.fuzzy.engine).toBe("fts5");
    expect(cfg.dedup.fuzzy.top_k).toBe(3);
    expect(cfg.git.auto_commit).toBe(true);
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
    expect(cfg.capture.mode).toBe("manual");
    expect(cfg.vault.path).toBe(join(dir, "vault"));
  });

  it("rejects missing vault.path", () => {
    const dir = mkdtempSync(join(testTmpDir(), "cfg-reject-no-vault-"));
    expect(() => loadConfig({ projectRoot: dir, skipGlobal: true })).toThrow(
      /Invalid knowledge-hub config/,
    );
  });
});
