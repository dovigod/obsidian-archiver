import type { Config } from "@core/config";
import type { EntitiesRepository } from "@core/db/repository/entities";
import { newId } from "@core/ids";
import type { LLMProvider } from "@core/llm/provider";
import { rewriteEntityBody } from "@core/pipeline/rewrite";
import type {
  Conversation,
  DedupResult,
  ExtractedEntity,
} from "@core/schema";

export interface ExecuteArgs {
  config: Config;
  llm: LLMProvider;
  entitiesRepo: EntitiesRepository;
  conversation: Conversation;
  candidate: ExtractedEntity;
  dedup: DedupResult;
}

export interface ExecuteResult {
  /** Entity id that was created or updated. */
  entityId: string;
  /** Canonical name for the entity row after the operation. */
  entityName: string;
  /** True when a new row was inserted; false when an existing row was rewritten. */
  created: boolean;
  /** Matched on a fuzzy/dedup hit (non-null when created=false). */
  matched: string | null;
}

/**
 * Apply one dedup decision against the SQLite store.
 *
 * - `kind: "new"`     → INSERT entity + aliases + source link; body is the
 *                       extractor's `draft_body` (no rewrite call needed).
 * - `kind: "match"`   → LLM-rewrite the existing body integrating the new
 *                       conversation excerpt; merge new aliases + add source.
 *
 * The renderer is NOT called inline here — the run-loop or sync command
 * picks up the dirty rows.
 */
export async function executeDecision(
  args: ExecuteArgs,
): Promise<ExecuteResult> {
  const { entitiesRepo, candidate, dedup, conversation } = args;

  if (dedup.kind === "new") {
    const id = newId();
    entitiesRepo.create({
      id,
      name: candidate.name,
      summary: candidate.summary,
      bodyMd: candidate.draft_body,
      aliases: candidate.aliases,
    });
    entitiesRepo.addSource(id, conversation.id);
    return {
      entityId: id,
      entityName: candidate.name,
      created: true,
      matched: null,
    };
  }

  // dedup.kind === "match"
  const existing = entitiesRepo.findById(dedup.entityId);
  if (!existing) {
    // Race / cleanup: candidate disappeared. Fall back to creating a fresh row.
    const id = newId();
    entitiesRepo.create({
      id,
      name: candidate.name,
      summary: candidate.summary,
      bodyMd: candidate.draft_body,
      aliases: candidate.aliases,
    });
    entitiesRepo.addSource(id, conversation.id);
    return {
      entityId: id,
      entityName: candidate.name,
      created: true,
      matched: null,
    };
  }

  const newBody = await rewriteEntityBody(args.llm, {
    name: existing.name,
    existingBody: existing.bodyMd,
    conversation,
  });

  entitiesRepo.updateBody({
    id: existing.id,
    bodyMd: newBody,
    summary: existing.summary || candidate.summary,
  });
  entitiesRepo.addAliases(existing.id, [
    candidate.name,
    ...candidate.aliases,
  ]);
  entitiesRepo.addSource(existing.id, conversation.id);

  return {
    entityId: existing.id,
    entityName: existing.name,
    created: false,
    matched: dedup.matchedTerm ?? existing.name,
  };
}
