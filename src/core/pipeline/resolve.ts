import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt, render } from "@core/llm/prompts";
import type { ClassifiedEntity } from "@core/pipeline/classify";
import { extractJson } from "@core/pipeline/json";

export interface ResolveResult {
  match: string | null;
  reason?: string;
}

export interface KnowledgeGraphEntry {
  name: string;
  categories: string[];
}

const GRAPH_LIMIT = 500;

/**
 * Decide whether `candidate` matches an entity already in `graph`. When the
 * graph is empty we short-circuit to {match: null} without an LLM call.
 *
 * When the graph exceeds GRAPH_LIMIT, we keyword-prefilter to keep the prompt
 * small. (Stage 5 will swap this for vector retrieval.)
 */
export async function resolveEntity(
  llm: LLMProvider,
  candidate: ClassifiedEntity,
  graph: readonly KnowledgeGraphEntry[],
): Promise<ResolveResult> {
  if (graph.length === 0) {
    return { match: null, reason: "empty graph" };
  }
  const limited = limitGraph(graph, candidate, GRAPH_LIMIT);
  const tpl = await loadPrompt("resolve");
  const prompt = render(tpl, {
    graph: limited
      .map((e) => `- ${e.name} (${e.categories.join(", ")})`)
      .join("\n"),
    name: candidate.name,
    categories: candidate.categories.join(", "),
    summary: candidate.summary,
  });
  const text = await llm.complete({ prompt, maxTokens: 256 });
  const parsed = extractJson<{ match: string | null; reason?: string }>(text);
  const result: ResolveResult = { match: parsed.match ?? null };
  if (parsed.reason !== undefined) {
    result.reason = parsed.reason;
  }
  return result;
}

function limitGraph(
  graph: readonly KnowledgeGraphEntry[],
  candidate: ClassifiedEntity,
  limit: number,
): KnowledgeGraphEntry[] {
  if (graph.length <= limit) {
    return [...graph];
  }
  const tokens = new Set(
    [candidate.name, ...candidate.categories]
      .flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
  );
  const scored = graph.map((entry) => {
    const haystack = `${entry.name} ${entry.categories.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (t && haystack.includes(t)) {
        score++;
      }
    }
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}
