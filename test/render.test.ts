import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteHandle } from "@core/db/client";
import { EntitiesRepository } from "@core/db/repository/entities";
import { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import { newId } from "@core/ids";
import { renderDirty } from "@core/pipeline/render";
import { openTestDb, prepareVaultRepo, testTmpDir } from "./helpers";

describe("renderDirty", () => {
  let openHandle: SqliteHandle | null = null;
  afterEach(() => {
    openHandle?.close();
    openHandle = null;
  });

  async function fresh() {
    const dir = mkdtempSync(join(testTmpDir(), "render-"));
    const vault = join(dir, "vault");
    await prepareVaultRepo(vault);
    const { db, sqlite } = openTestDb(vault);
    openHandle = sqlite;
    return {
      vault,
      entities: new EntitiesRepository(db),
      renderedFiles: new RenderedFilesRepository(db),
    };
  }

  it("writes md for dirty entities and records the manifest row", async () => {
    const { vault, entities, renderedFiles } = await fresh();
    const id = newId();
    entities.create({
      id,
      name: "Redis",
      summary: "kv store",
      bodyMd: "## Overview\n\nIn-memory key-value store.\n",
      aliases: ["redis-server"],
    });
    const result = await renderDirty(vault, entities, renderedFiles);
    expect(result.written).toEqual([join("knowledge", "Redis.md")]);
    expect(result.deleted).toEqual([]);

    const rendered = readFileSync(join(vault, "knowledge", "Redis.md"), "utf8");
    const parsed = matter(rendered);
    expect(parsed.data.id).toBe(id);
    expect(parsed.data.name).toBe("Redis");
    expect(parsed.data.aliases).toEqual(["redis-server"]);
    expect(parsed.content).toMatch(/# Redis/);
    expect(parsed.content).toMatch(/In-memory key-value store/);

    const manifest = renderedFiles.findByPath(join("knowledge", "Redis.md"));
    expect(manifest).toBeTruthy();
    expect(manifest?.kind).toBe("entity");
    expect(manifest?.sourceId).toBe(id);
    expect(manifest?.lastRenderedHash).toBeTruthy();
  });

  it("is idempotent: second render of unchanged entity writes nothing", async () => {
    const { vault, entities, renderedFiles } = await fresh();
    entities.create({
      id: newId(),
      name: "Redis",
      summary: "",
      bodyMd: "## Overview\n\nBody.\n",
    });
    const first = await renderDirty(vault, entities, renderedFiles);
    expect(first.written.length).toBe(1);
    const second = await renderDirty(vault, entities, renderedFiles);
    expect(second.written.length).toBe(0);
  });

  it("soft-deleted entities have their rendered md removed", async () => {
    const { vault, entities, renderedFiles } = await fresh();
    const id = newId();
    entities.create({
      id,
      name: "Ephemeral",
      summary: "",
      bodyMd: "## Overview\n\nx\n",
    });
    await renderDirty(vault, entities, renderedFiles);
    const path = join(vault, "knowledge", "Ephemeral.md");
    expect(existsSync(path)).toBe(true);

    entities.softDelete(id);
    const result = await renderDirty(vault, entities, renderedFiles);
    expect(result.deleted).toContain(join("knowledge", "Ephemeral.md"));
    expect(existsSync(path)).toBe(false);
    expect(renderedFiles.findByPath(join("knowledge", "Ephemeral.md"))).toBeUndefined();
  });

  it("detects drift and stages the hand-edited content under _proposals/manual_edit/", async () => {
    const { vault, entities, renderedFiles } = await fresh();
    const id = newId();
    entities.create({
      id,
      name: "Redis",
      summary: "",
      bodyMd: "## Overview\n\nv1\n",
    });
    await renderDirty(vault, entities, renderedFiles);

    // Simulate a hand-edit on the rendered file
    const rel = join(vault, "knowledge", "Redis.md");
    const original = readFileSync(rel, "utf8");
    writeFileSync(rel, original + "\n## My Notes\n\nHand-edited!\n");

    // Mark the entity dirty so the renderer runs again
    entities.updateBody({ id, bodyMd: "## Overview\n\nv2\n" });

    const result = await renderDirty(vault, entities, renderedFiles);
    expect(result.driftStaged.length).toBe(1);

    const proposalDir = join(vault, "_proposals", "manual_edit");
    expect(existsSync(proposalDir)).toBe(true);
    const files = await readdir(proposalDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});
