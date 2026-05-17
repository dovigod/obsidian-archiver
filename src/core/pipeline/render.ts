import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import { newId } from "@core/ids";
import type { EntitiesRepository } from "@core/db/repository/entities";
import type { RenderedFilesRepository } from "@core/db/repository/rendered_files";
import type { EntityRow } from "@core/db/schema";
import { ProposalRepository } from "@core/repository/proposals";
import type { ProposalRecord } from "@core/schema";

const RENDERED_BANNER =
  "<!-- ⚠️  Generated from .kh.db by `kh sync`. Hand edits are detected " +
  "and staged under _proposals/manual_edit/ on the next sync. -->";

export interface RenderOptions {
  /** Stage drifted files under `_proposals/manual_edit/` before overwriting. */
  detectDrift?: boolean;
}

export interface RenderResult {
  written: string[];
  deleted: string[];
  driftStaged: string[];
}

/**
 * Rebuild rendered markdown for every dirty entity. Idempotent and
 * crash-safe: `rendered_files.last_rendered_at` + `last_rendered_hash` are
 * bumped immediately after each successful write.
 */
export async function renderDirty(
  vaultPath: string,
  entitiesRepo: EntitiesRepository,
  renderedRepo: RenderedFilesRepository,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const detectDrift = options.detectDrift ?? true;
  const result: RenderResult = { written: [], deleted: [], driftStaged: [] };
  const proposals = new ProposalRepository(vaultPath);

  // Deletes first — keeps the manifest tidy when an entity is both deleted
  // and updated (the soft-delete wins).
  for (const ent of entitiesRepo.listDeletedSinceSync()) {
    const rel = entityRelativePath(ent.name);
    const abs = join(resolve(vaultPath), rel);
    if (existsSync(abs)) {
      await rm(abs, { force: true });
    }
    renderedRepo.delete(rel);
    entitiesRepo.markSynced(ent.id);
    result.deleted.push(rel);
  }

  for (const ent of entitiesRepo.listDirty()) {
    const rel = entityRelativePath(ent.name);
    const abs = join(resolve(vaultPath), rel);
    const aliases = entitiesRepo.listAliases(ent.id);
    const conversationIds = entitiesRepo.listConversationIdsForEntity(ent.id);
    const newText = composeEntityMarkdown({
      entity: ent,
      aliases,
      conversationIds,
    });

    if (detectDrift && existsSync(abs)) {
      const current = await readFile(abs, "utf8");
      const currentHash = sha256(current);
      const manifestRow = renderedRepo.findByPath(rel);
      const expectedHash = manifestRow?.lastRenderedHash
        ? Buffer.from(manifestRow.lastRenderedHash as Buffer).toString("hex")
        : null;
      if (expectedHash !== null && currentHash !== expectedHash) {
        const staged = await stageManualEdit(proposals, ent.name, current);
        result.driftStaged.push(staged);
      }
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, newText, "utf8");

    const hashHex = sha256(newText);
    renderedRepo.recordRender({
      path: rel,
      kind: "entity",
      sourceId: ent.id,
      hash: Buffer.from(hashHex, "hex"),
    });
    entitiesRepo.markSynced(ent.id);
    result.written.push(rel);
  }

  return result;
}

interface ComposeArgs {
  entity: EntityRow;
  aliases: readonly string[];
  conversationIds: readonly string[];
}

function composeEntityMarkdown(args: ComposeArgs): string {
  const { entity, aliases, conversationIds } = args;
  const data: Record<string, unknown> = {
    id: entity.id,
    name: entity.name,
    aliases: [...aliases].sort(),
    updated_at: new Date(entity.updatedAt).toISOString(),
  };
  if (entity.summary) {
    data.summary = entity.summary;
  }
  if (conversationIds.length) {
    data.sources = [...conversationIds].sort();
  }
  const sourcesSection = renderSourcesSection(conversationIds);
  const body = (entity.bodyMd ?? "").trim();
  const composed = body
    ? `${RENDERED_BANNER}\n# ${entity.name}\n\n${body}\n\n${sourcesSection}`
    : `${RENDERED_BANNER}\n# ${entity.name}\n\n${sourcesSection}`;
  return matter.stringify(composed, data);
}

function renderSourcesSection(conversationIds: readonly string[]): string {
  if (conversationIds.length === 0) {
    return "## Sources\n";
  }
  const lines = [...conversationIds]
    .sort()
    .map((id) => `- [[raw/conversations/${id}|${id}]]`)
    .join("\n");
  return `## Sources\n\n${lines}\n`;
}

function entityRelativePath(name: string): string {
  return join("knowledge", `${entityFilenameSlug(name)}.md`);
}

/** Strip filename-unsafe characters. Whitespace becomes underscores. */
export function entityFilenameSlug(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function stageManualEdit(
  proposals: ProposalRepository,
  entityName: string,
  driftedContent: string,
): Promise<string> {
  const record: ProposalRecord = {
    id: newId(),
    kind: "manual_edit",
    created_at: new Date().toISOString(),
    conversation_id: "",
    entity_name: entityName,
    payload: { content: driftedContent },
  };
  const { relativePath } = await proposals.write(record);
  return relativePath;
}
