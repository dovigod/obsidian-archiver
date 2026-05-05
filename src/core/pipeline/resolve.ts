import type { Config } from "@core/config";
import type { EntitySummary } from "@core/repository/knowledge";
import {
  type CandidateCategory,
  type CandidateEntity,
  type ClassifyInput,
  type ExtractedEntity,
} from "@core/schema";

/**
 * Cap on `candidate_entities` AND `candidate_categories` shipped to the
 * classifier. Pulled from `config.entity_resolution.graph_max_entities`.
 *
 * Stage 5 will swap the keyword-retrieval prefilter for vector retrieval; the
 * cap stays in place either way so the prompt always receives a bounded slice.
 */

interface ScoredEntity {
  entry: EntitySummary;
  score: number;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Lightweight overlap score in [0,1]. Used today as a stand-in for vector
 * similarity. Exact token match is enough for the empty/small-graph regime.
 */
function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const aSet = new Set(a);
  let hits = 0;
  for (const t of b) {
    if (aSet.has(t)) {
      hits++;
    }
  }
  // Jaccard-ish: shared / union of distinct tokens.
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : hits / union;
}

function categoryIdSlug(name: string): string {
  return `cat_${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

/**
 * Aggregate the existing graph into category-level candidates. Each unique
 * category name across all entities becomes one candidate, scored by simple
 * Jaccard overlap against the new node.
 */
function buildCandidateCategories(
  newNode: ExtractedEntity,
  graph: readonly EntitySummary[],
): CandidateCategory[] {
  const newTokens = [
    ...tokenize(newNode.name),
    ...newNode.tags.flatMap(tokenize),
    ...tokenize(newNode.summary),
  ];

  const byName = new Map<string, CandidateCategory>();
  for (const ent of graph) {
    for (const cat of ent.categories) {
      const id = categoryIdSlug(cat);
      const existing = byName.get(cat);
      if (existing) {
        if (existing.sibling_examples.length < 5) {
          existing.sibling_examples.push(ent.name);
        }
      } else {
        const score = similarity(newTokens, [
          ...tokenize(cat),
          ...tokenize(ent.name),
        ]);
        byName.set(cat, {
          id,
          name: cat,
          summary: "",
          path: [],
          sibling_examples: [ent.name],
          similarity_score: Number(score.toFixed(4)),
        });
      }
    }
  }

  return Array.from(byName.values());
}

/**
 * Score every existing entity against the new node by name/alias overlap and
 * keep the top-K. Replaces the prior LLM-driven `resolveEntity`; entity-level
 * duplicate detection now happens inside the classifier prompt itself.
 */
function buildCandidateEntities(
  newNode: ExtractedEntity,
  graph: readonly EntitySummary[],
  limit: number,
): CandidateEntity[] {
  if (graph.length === 0) {
    return [];
  }
  const newTokens = [
    ...tokenize(newNode.name),
    ...newNode.aliases.flatMap(tokenize),
  ];

  const scored: ScoredEntity[] = graph.map((entry) => {
    const entryTokens = [
      ...tokenize(entry.name),
      ...entry.aliases.flatMap(tokenize),
    ];
    return { entry, score: similarity(newTokens, entryTokens) };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit);
  return top
    .filter((s) => s.score > 0 || top.length <= limit / 2)
    .map((s) => ({
      id: s.entry.id || s.entry.name,
      name: s.entry.name,
      summary: "",
      aliases: s.entry.aliases,
    }));
}

/**
 * Truncate candidate categories to the global cap, preferring higher
 * similarity scores. We rank both candidate sets together against the same
 * limit since they share the prompt's token budget.
 */
function rankAndCap<T extends { similarity_score?: number }>(
  items: T[],
  limit: number,
): T[] {
  const scored: Array<{ item: T; score: number }> = items.map((item) => ({
    item,
    score: typeof item.similarity_score === "number" ? item.similarity_score : 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

export interface BuildClassifyInputArgs {
  config: Config;
  newNode: ExtractedEntity;
  graph: readonly EntitySummary[];
}

/**
 * Build a ClassifyInput from the new node + existing graph + config.
 *
 * Pure data transform — no LLM call. The classifier prompt itself is
 * responsible for picking the primary parent, detecting duplicates, deciding
 * mode, and flagging rebalancing. This keeps autonomy gating in one place.
 */
export function buildClassifyInput({
  config,
  newNode,
  graph,
}: BuildClassifyInputArgs): ClassifyInput {
  const cap = config.entity_resolution.graph_max_entities;

  const allCategories = buildCandidateCategories(newNode, graph);
  const candidate_categories = rankAndCap<CandidateCategory>(
    allCategories,
    cap,
  );
  const candidate_entities = buildCandidateEntities(newNode, graph, cap);

  return {
    new_node: {
      name: newNode.name,
      summary: newNode.summary,
      tags: newNode.tags,
      aliases: newNode.aliases,
    },
    candidate_categories,
    candidate_entities,
    nearby_nodes: [],
    existing_relations: [],
    ontology_rules: [],
    autonomy_policy: {
      auto_actions: config.autonomy.auto_actions,
      proposal_actions: config.autonomy.proposal_actions,
    },
    confidence_thresholds: {
      auto_min: config.classification.confidence_thresholds.auto_min,
      propose_min: config.classification.confidence_thresholds.propose_min,
    },
    ontology_health_signals: {
      category_entropy: {},
      sibling_coherence: {},
      overloaded_categories: [],
    },
  };
}
