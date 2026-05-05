import type { LLMProvider } from "@core/llm/provider";
import { loadPrompt } from "@core/llm/prompts";
import { extractJson } from "@core/pipeline/json";
import {
  type ClassifyInput,
  type ClassifyOutput,
  ClassifyOutputSchema,
} from "@core/schema";

export interface ClassifyResult {
  output: ClassifyOutput;
  /**
   * Set when both the initial response and the retry failed validation. The
   * caller stages a `raw_invalid` proposal carrying this text and falls back
   * to `mode=proposal`.
   */
  fallbackRaw?: string;
}

function formatZodIssues(err: unknown): string {
  const anyErr = err as { issues?: Array<{ path: unknown; message: string }> };
  if (!Array.isArray(anyErr.issues)) {
    return String(err);
  }
  return anyErr.issues
    .map(
      (i) =>
        `${(Array.isArray(i.path) ? i.path.join(".") : "(root)") || "(root)"}: ${i.message}`,
    )
    .join("; ");
}

function tryParse(text: string):
  | { ok: true; output: ClassifyOutput }
  | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = extractJson<unknown>(text);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const parsed = ClassifyOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: formatZodIssues(parsed.error) };
  }
  return { ok: true, output: parsed.data };
}

/**
 * Build a synthetic ClassifyOutput when both the initial response and the
 * retry fail schema validation. Per design.md:
 *   "a second failure falls back to `mode=proposal` with the raw text
 *    attached to the proposal file."
 *
 * The raw text travels back to the caller via `ClassifyResult.fallbackRaw`
 * and gets persisted under `_proposals/raw_invalid/`.
 */
function fallbackProposal(rawText: string): ClassifyOutput {
  return {
    decision: {
      is_duplicate_of: null,
      primary_parent_id: "",
      primary_parent_name: "",
      additional_index_ids: [],
      additional_index_names: [],
      new_category_proposal: null,
      aliases: [],
      secondary_relations: [],
      confidence: 0,
    },
    mode: "proposal",
    reasoning: {
      semantic_fit: "",
      sibling_analysis: "",
      rejected_candidates: [],
      ontology_considerations:
        "Validation failed twice; raw classifier text staged for human review.",
    },
    rebalancing: { needed: false, reasons: [], actions: [] },
    warnings: [
      "ClassifyOutput failed schema validation twice. Raw text length: " +
        String(rawText.length),
    ],
  };
}

/**
 * Stage 2 classifier. Calls the ontology-maintenance prompt at
 * `prompts/classify.md` with `ClassifyInput` JSON, validates the response
 * with `ClassifyOutputSchema`, and follows the retry/fallback contract from
 * design.md:
 *
 *   1. First call → validate.
 *   2. On schema-validation failure → exactly one retry with the prior raw
 *      text and the validation error appended to the prompt.
 *   3. On a second failure → return `mode=proposal` synthesizing a stub
 *      decision and surface the raw text via `ClassifyResult.fallbackRaw`.
 */
export async function classifyEntity(
  llm: LLMProvider,
  input: ClassifyInput,
): Promise<ClassifyResult> {
  const tpl = await loadPrompt("classify");
  const inputJson = JSON.stringify(input, null, 2);
  const basePrompt = `${tpl}\n\n---\n\n# Input\n\n\`\`\`json\n${inputJson}\n\`\`\``;

  const first = await llm.complete({ prompt: basePrompt, maxTokens: 4096 });
  const firstParsed = tryParse(first);
  if (firstParsed.ok) {
    return { output: firstParsed.output };
  }

  const retryPrompt = [
    basePrompt,
    "",
    "---",
    "",
    "Your previous response failed JSON-schema validation:",
    "",
    `Error: ${firstParsed.reason}`,
    "",
    "Previous raw response:",
    "```",
    first,
    "```",
    "",
    "Reply again with ONLY the JSON object, matching the documented schema. No prose, no fences, no trailing commas.",
  ].join("\n");

  const second = await llm.complete({ prompt: retryPrompt, maxTokens: 4096 });
  const secondParsed = tryParse(second);
  if (secondParsed.ok) {
    return { output: secondParsed.output };
  }

  return { output: fallbackProposal(second), fallbackRaw: second };
}
