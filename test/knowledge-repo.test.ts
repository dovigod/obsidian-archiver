import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import {
  type EntityPage,
  KnowledgeRepository,
} from "@core/repository/knowledge";
import { testTmpDir } from "./helpers";

function makePage(overrides: Partial<EntityPage> = {}): EntityPage {
  return {
    id: "01923-test",
    name: "Redis",
    categories: ["Database", "Caching"],
    aliases: [],
    primary_parent_id: null,
    primary_parent_name: null,
    additional_index_ids: [],
    additional_index_names: [],
    sources: [
      {
        id: "conv-1",
        path: "raw/conversations/2026/05/conv-1",
        label: "2026-05-02 — first",
      },
    ],
    updated_at: "2026-05-02T00:00:00.000Z",
    body: "## Overview\n\nIn-memory KV store.\n\n## Notes\n\n- Single-threaded.\n",
    ...overrides,
  };
}

describe("KnowledgeRepository", () => {
  it("writes entity page with frontmatter, H1, body, and Sources section", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-write-"));
    const repo = new KnowledgeRepository(dir);
    const { absolutePath, relativePath } = await repo.writeEntity(makePage());

    expect(relativePath).toBe(join("knowledge", "Redis.md"));

    const text = readFileSync(absolutePath, "utf8");
    const parsed = matter(text);
    expect(parsed.data.id).toBe("01923-test");
    expect(parsed.data.name).toBe("Redis");
    expect(parsed.data.categories).toEqual(["Database", "Caching"]);
    expect(parsed.content).toMatch(/^# Redis/m);
    expect(parsed.content).toMatch(/## Overview/);
    expect(parsed.content).toMatch(/## Notes/);
    expect(parsed.content).toMatch(/## Sources/);
    expect(parsed.content).toMatch(
      /\[\[raw\/conversations\/2026\/05\/conv-1\|2026-05-02 — first\]\]/,
    );
  });

  it("readEntity round-trips a written page (H1 and Sources section stripped from body)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-read-"));
    const repo = new KnowledgeRepository(dir);
    await repo.writeEntity(makePage());

    const back = await repo.readEntity("Redis");
    expect(back).toBeTruthy();
    expect(back?.id).toBe("01923-test");
    expect(back?.name).toBe("Redis");
    expect(back?.categories).toEqual(["Database", "Caching"]);
    expect(back?.sources?.length).toBe(1);
    expect(back?.sources?.[0]?.id).toBe("conv-1");
    expect(back?.body ?? "").not.toMatch(/^# Redis/m);
    expect(back?.body ?? "").not.toMatch(/## Sources/);
    expect(back?.body ?? "").toMatch(/## Overview/);
  });

  it("readEntity returns null when not present", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-missing-"));
    const repo = new KnowledgeRepository(dir);
    expect(await repo.readEntity("DoesNotExist")).toBeNull();
  });

  it("listEntities surfaces names + categories", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-list-"));
    const repo = new KnowledgeRepository(dir);
    await repo.writeEntity(
      makePage({
        name: "Redis",
        categories: ["Database"],
        body: "## Overview\n\nx",
        sources: [],
      }),
    );
    await repo.writeEntity(
      makePage({
        id: "id2",
        name: "OAuth2",
        categories: ["Auth"],
        body: "## Overview\n\ny",
        sources: [],
      }),
    );
    const list = await repo.listEntities();
    const names = list.map((e) => e.name).sort();
    expect(names).toEqual(["OAuth2", "Redis"]);
  });

  it("entity name with spaces slugifies safely (Redis Cluster -> Redis_Cluster.md)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-slug-"));
    const repo = new KnowledgeRepository(dir);
    const { relativePath } = await repo.writeEntity(
      makePage({ name: "Redis Cluster", sources: [] }),
    );
    expect(relativePath).toBe(join("knowledge", "Redis_Cluster.md"));
  });
});
