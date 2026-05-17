import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveConversation } from "@core/archive";
import { loadConfig } from "@core/config";
import type { SqliteHandle } from "@core/db/client";
import { ConversationsRepository } from "@core/db/repository/conversations";
import { EntitiesRepository } from "@core/db/repository/entities";
import { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import { exportVault } from "@core/io/export";
import { importVault } from "@core/io/import";
import { newId } from "@core/ids";
import { renderDirty } from "@core/pipeline/render";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("export → import roundtrip", () => {
  const handles: SqliteHandle[] = [];
  afterEach(() => {
    while (handles.length) {
      handles.pop()?.close();
    }
  });

  async function seedVault() {
    const dir = mkdtempSync(join(testTmpDir(), "export-seed-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const config = loadConfig({
      skipGlobal: true,
      overrides: {
        vault: { path: vault },
        git: { auto_commit: false },
      },
    });
    const { db, sqlite } = openTestDb(vault);
    handles.push(sqlite);

    // Seed: two archived conversations + one rendered entity row.
    await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-02T14:22:00.000Z",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
    );
    await archiveConversation(
      { config, db, sqlite },
      {
        source: "claude-code",
        created_at: "2026-05-03T14:22:00.000Z",
        messages: [
          { role: "user", content: "second" },
          { role: "assistant", content: "second back" },
        ],
      },
    );

    const entities = new EntitiesRepository(db);
    const renderedFiles = new RenderedFilesRepository(db);
    entities.create({
      id: newId(),
      name: "Redis",
      summary: "kv store",
      bodyMd: "## Overview\n\nIn-memory key-value store.\n",
      aliases: ["redis-server"],
    });
    await renderDirty(vault, entities, renderedFiles);

    return { dir, vault, config, db, sqlite };
  }

  it("export bundle round-trips into a fresh vault", async () => {
    const seed = await seedVault();

    const exportResult = await exportVault(seed.vault, seed.sqlite);
    expect(exportResult.outputPath).toMatch(/kh-export-[\d:.\-TZ]+\.tar\.gz$/);
    expect(existsSync(exportResult.outputPath)).toBe(true);
    expect(exportResult.files).toContain("raw");
    expect(exportResult.files).toContain("knowledge");
    expect(exportResult.files).toContain("kh.sql");

    // Close source DB before importing to avoid SQLite lock surprises.
    seed.sqlite.close();
    handles.pop();

    // Import into a fresh, empty target vault.
    const targetDir = mkdtempSync(join(testTmpDir(), "export-import-"));
    const targetVault = join(targetDir, "vault");
    const result = await importVault(exportResult.outputPath, targetVault);
    expect(result.dbRestored).toBe(true);
    expect(result.extracted).toBeGreaterThan(0);

    // Open the imported DB and verify state matches.
    const reopened = openTestDb(targetVault);
    handles.push(reopened.sqlite);
    const targetConvos = new ConversationsRepository(reopened.db);
    const targetEntities = new EntitiesRepository(reopened.db);

    expect(targetConvos.count()).toBe(2);
    const redis = targetEntities.findByName("Redis");
    expect(redis).toBeTruthy();
    expect(redis?.summary).toBe("kv store");

    // Imported raw conversation files should still be readable.
    const rawRoot = join(targetVault, "raw", "conversations");
    expect(existsSync(rawRoot)).toBe(true);
    const sampleConvoId = targetConvos.listAllIds()[0]!;
    const row = targetConvos.findById(sampleConvoId);
    expect(row).toBeTruthy();
    expect(existsSync(join(targetVault, row!.rawPath))).toBe(true);
    expect(readFileSync(join(targetVault, row!.rawPath), "utf8")).toMatch(
      /# (User|Assistant)/,
    );
  });

  it("import refuses non-empty target without force", async () => {
    const seed = await seedVault();
    const exportResult = await exportVault(seed.vault, seed.sqlite);
    seed.sqlite.close();
    handles.pop();

    // Re-importing into the same (non-empty) vault must throw.
    await expect(importVault(exportResult.outputPath, seed.vault)).rejects.toThrow(
      /already has vault content/,
    );
  });

  it("import with force overwrites a non-empty vault", async () => {
    const seed = await seedVault();
    const exportResult = await exportVault(seed.vault, seed.sqlite);
    seed.sqlite.close();
    handles.pop();

    const result = await importVault(exportResult.outputPath, seed.vault, {
      force: true,
    });
    expect(result.dbRestored).toBe(true);
  });
});
