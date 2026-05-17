import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initVault } from "@core/init";
import {
  SMART_CONNECTIONS_DOC_CONTENT,
  SMART_CONNECTIONS_DOC_FILENAME,
  detectSmartConnections,
  writeSmartConnectionsDoc,
} from "@core/smart-connections";
import { prepareVaultRepo, testTmpDir } from "./helpers";

describe("writeSmartConnectionsDoc", () => {
  it("writes the doc when absent and is idempotent on re-run", () => {
    const dir = mkdtempSync(join(testTmpDir(), "sc-doc-"));

    const first = writeSmartConnectionsDoc(dir);
    expect(first.written).toBe(true);
    expect(existsSync(first.absolutePath)).toBe(true);
    const content = readFileSync(first.absolutePath, "utf8");
    expect(content).toBe(SMART_CONNECTIONS_DOC_CONTENT);
    expect(content).toMatch(/Folders to include/);
    expect(content).toMatch(/`knowledge\/`/);

    const second = writeSmartConnectionsDoc(dir);
    expect(second.written).toBe(false);
    expect(readFileSync(second.absolutePath, "utf8")).toBe(content);
  });

  it("preserves user edits — re-run does not overwrite", () => {
    const dir = mkdtempSync(join(testTmpDir(), "sc-doc-preserve-"));
    const handEdited = "# My custom notes\n";
    writeFileSync(join(dir, SMART_CONNECTIONS_DOC_FILENAME), handEdited);

    const result = writeSmartConnectionsDoc(dir);
    expect(result.written).toBe(false);
    expect(readFileSync(result.absolutePath, "utf8")).toBe(handEdited);
  });
});

describe("detectSmartConnections", () => {
  it("returns false when .smart-env/ is absent", () => {
    const dir = mkdtempSync(join(testTmpDir(), "sc-detect-absent-"));
    expect(detectSmartConnections(dir)).toBe(false);
  });

  it("returns true when .smart-env/ exists", () => {
    const dir = mkdtempSync(join(testTmpDir(), "sc-detect-present-"));
    mkdirSync(join(dir, ".smart-env"), { recursive: true });
    expect(detectSmartConnections(dir)).toBe(true);
  });
});

describe("initVault (Stage 4 polish)", () => {
  it("scaffolds dirs, .gitignore, .kh.db, SMART_CONNECTIONS.md, and commits", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "init-scaffold-"));
    const vault = join(dir, "vault");
    // Pre-prepare git repo so initVault skips its own git init (commit needs
    // user.email/name; prepareVaultRepo sets them locally).
    await prepareVaultRepo(vault);

    const result = await initVault(vault);
    expect(result.vaultPath).toBe(vault);
    expect(result.smartConnectionsDocWritten).toBe(true);
    // .git already existed → initVault skipped its git init branch
    expect(result.gitInitialized).toBe(false);

    for (const sub of [
      "raw/conversations",
      "knowledge",
      "_proposals",
      "_backups",
    ]) {
      expect(existsSync(join(vault, sub))).toBe(true);
    }
    expect(existsSync(join(vault, ".kh.db"))).toBe(true);

    const gitignore = readFileSync(join(vault, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/\.smart-env\//);

    const doc = readFileSync(
      join(vault, SMART_CONNECTIONS_DOC_FILENAME),
      "utf8",
    );
    expect(doc).toMatch(/Smart Connections setup/);
    expect(doc).toMatch(/Folders to include/);
    expect(doc).toMatch(/`knowledge\/`/);
  });

  it("preserves a hand-edited SMART_CONNECTIONS.md on re-init", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "init-doc-preserve-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const docPath = join(vault, SMART_CONNECTIONS_DOC_FILENAME);
    const customContent = "# Custom notes the user wrote\n";
    writeFileSync(docPath, customContent);

    const result = await initVault(vault);
    expect(result.smartConnectionsDocWritten).toBe(false);
    expect(readFileSync(docPath, "utf8")).toBe(customContent);
  });

  it("is idempotent — re-running on an initialized vault is a no-op", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "init-idempotent-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);

    const first = await initVault(vault);
    const dbStat = readFileSync(join(vault, ".kh.db"));
    const docFirst = readFileSync(join(vault, SMART_CONNECTIONS_DOC_FILENAME), "utf8");
    expect(first.smartConnectionsDocWritten).toBe(true);

    const second = await initVault(vault);
    expect(second.smartConnectionsDocWritten).toBe(false);
    // Doc + DB preserved across re-init
    expect(readFileSync(join(vault, SMART_CONNECTIONS_DOC_FILENAME), "utf8")).toBe(
      docFirst,
    );
    expect(readFileSync(join(vault, ".kh.db")).length).toBeGreaterThanOrEqual(
      dbStat.length,
    );
  });
});
