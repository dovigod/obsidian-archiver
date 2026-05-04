import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import matter from "gray-matter";
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

    assert.equal(relativePath, join("knowledge", "Redis.md"));

    const text = readFileSync(absolutePath, "utf8");
    const parsed = matter(text);
    assert.equal(parsed.data.id, "01923-test");
    assert.equal(parsed.data.name, "Redis");
    assert.deepEqual(parsed.data.categories, ["Database", "Caching"]);
    assert.match(parsed.content, /^# Redis/m);
    assert.match(parsed.content, /## Overview/);
    assert.match(parsed.content, /## Notes/);
    assert.match(parsed.content, /## Sources/);
    assert.match(
      parsed.content,
      /\[\[raw\/conversations\/2026\/05\/conv-1\|2026-05-02 — first\]\]/,
    );
  });

  it("readEntity round-trips a written page (H1 and Sources section stripped from body)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-read-"));
    const repo = new KnowledgeRepository(dir);
    await repo.writeEntity(makePage());

    const back = await repo.readEntity("Redis");
    assert.ok(back);
    assert.equal(back?.id, "01923-test");
    assert.equal(back?.name, "Redis");
    assert.deepEqual(back?.categories, ["Database", "Caching"]);
    assert.equal(back?.sources?.length, 1);
    assert.equal(back?.sources?.[0]?.id, "conv-1");
    // body should NOT contain the H1 or the Sources section that we manage.
    assert.doesNotMatch(back?.body ?? "", /^# Redis/m);
    assert.doesNotMatch(back?.body ?? "", /## Sources/);
    assert.match(back?.body ?? "", /## Overview/);
  });

  it("readEntity returns null when not present", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-missing-"));
    const repo = new KnowledgeRepository(dir);
    assert.equal(await repo.readEntity("DoesNotExist"), null);
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
    assert.deepEqual(names, ["OAuth2", "Redis"]);
  });

  it("entity name with spaces slugifies safely (Redis Cluster -> Redis_Cluster.md)", async () => {
    const dir = mkdtempSync(join(testTmpDir(), "knrepo-slug-"));
    const repo = new KnowledgeRepository(dir);
    const { relativePath } = await repo.writeEntity(
      makePage({ name: "Redis Cluster", sources: [] }),
    );
    assert.equal(relativePath, join("knowledge", "Redis_Cluster.md"));
  });
});
