import type { EntitiesRepository } from "@core/db/repository/entities";
import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import { extractJson } from "@core/pipeline/json";
import {
  type DedupOutput,
  DedupOutputSchema,
  type DedupResult,
  type ExtractedEntity,
} from "@core/schema";

export interface DedupOptions {
  /** Max FTS5 candidates to consider. */
  topK: number;
  /**
   * Lower-bound on FTS5 score. SQLite's bm25() returns lower-is-better and
   * unbounded negative; we use `score <= minScoreCutoff` rather than a 0..1
   * cutoff. `minScore` from config is preserved here for parity but unused
   * in the current implementation — kept for future tuning.
   */
  minScore: number;
  /**
   * When true, fuzzy hits go through a confirm-prompt LLM call. When false,
   * fuzzy hits are accepted as matches (cheaper, lower precision).
   */
  llmConfirm: boolean;
}

/**
 * Resolve an extracted entity against existing rows.
 *
 *   1. exact name → match
 *   2. exact alias → match (returns owning entity)
 *   3. FTS5 fuzzy top-K
 *        none → new
 *        any  → LLM dedup-confirm (or accept top hit if llm_confirm=false)
 */
export async function dedupEntity(
  llm: LLMProvider,
  repo: EntitiesRepository,
  candidate: ExtractedEntity,
  options: DedupOptions,
): Promise<DedupResult> {
  // 1. Exact name match
  const byName = repo.findByName(candidate.name);
  if (byName && byName.deletedAt === null) {
    return { kind: "match", entityId: byName.id, matchedTerm: candidate.name };
  }

  // 2. Exact alias match — check the candidate's own name AND each alias
  //    against entity_aliases. ("psql" extracted as a name can still be an
  //    alias of an existing "PostgreSQL" entity.)
  const aliasProbes = [candidate.name, ...candidate.aliases];
  for (const alias of aliasProbes) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const byAlias = repo.findByExactAlias(trimmed);
    if (byAlias && byAlias.deletedAt === null) {
      return { kind: "match", entityId: byAlias.id, matchedTerm: trimmed };
    }
  }

  // 3. FTS5 fuzzy match
  const probe = [candidate.name, ...candidate.aliases].join(" ");
  const hits = repo.searchFuzzy(probe, options.topK);
  if (hits.length === 0) {
    return { kind: "new" };
  }

  // Dedup against the underlying entity rows so a single entity hit via
  // multiple aliases doesn't get double-counted.
  const seen = new Set<string>();
  const candidates: Array<{
    id: string;
    name: string;
    summary: string;
    aliases: string[];
  }> = [];
  for (const hit of hits) {
    if (seen.has(hit.entityId)) {
      continue;
    }
    seen.add(hit.entityId);
    const ent = repo.findById(hit.entityId);
    if (!ent || ent.deletedAt !== null) {
      continue;
    }
    candidates.push({
      id: ent.id,
      name: ent.name,
      summary: ent.summary,
      aliases: repo.listAliases(ent.id),
    });
  }
  if (candidates.length === 0) {
    return { kind: "new" };
  }

  if (!options.llmConfirm) {
    const top = candidates[0]!;
    return { kind: "match", entityId: top.id, matchedTerm: top.name };
  }

  const tpl = await loadPrompt("dedup");
  const prompt = render(tpl, {
    new_node: JSON.stringify({
      name: candidate.name,
      summary: candidate.summary,
      aliases: candidate.aliases,
    }),
    candidates: JSON.stringify(candidates),
  });
  const text = await llm.complete({ prompt, maxTokens: 256 });

  let parsedRaw: unknown;
  try {
    parsedRaw = extractJson<unknown>(text);
  } catch {
    return { kind: "new" };
  }
  const parsed = DedupOutputSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    return { kind: "new" };
  }
  const out: DedupOutput = parsed.data;
  if (out.match_id === null) {
    return { kind: "new" };
  }
  const matched = candidates.find((c) => c.id === out.match_id);
  if (!matched) {
    // LLM hallucinated an id not in our candidates list — treat as new.
    return { kind: "new" };
  }
  return { kind: "match", entityId: matched.id, matchedTerm: matched.name };
}
