/**
 * Extract a JSON object from an LLM response. Handles either bare JSON or a
 * triple-backtick fenced block (with optional `json` language tag).
 *
 * Throws with the original raw text included so debugging is easy when an LLM
 * returns prose instead of JSON.
 */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    throw new Error(
      `LLM output is not valid JSON: ${(err as Error).message}\n--- raw ---\n${text}\n--- end ---`,
      { cause: err },
    );
  }
}
