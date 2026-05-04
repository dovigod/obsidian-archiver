import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Prompts ship as sibling .md files under prompts/. The production build copies
// them into dist/core/llm/prompts/ via scripts/copy-prompts.mjs.
const here = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(here, "prompts");

export type PromptName =
  | "obsidian-markdown"
  | "classify"
  | "resolve"
  | "synthesize";

const cache = new Map<PromptName, string>();

export async function loadPrompt(name: PromptName): Promise<string> {
  let text = cache.get(name);
  if (text === undefined) {
    text = await readFile(join(PROMPTS_DIR, `${name}.md`), "utf8");
    cache.set(name, text);
  }
  return text;
}

/** Substitute {{name}} placeholders. Unknown placeholders become empty string. */
export function render(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, key: string) => {
    return vars[key] ?? "";
  });
}
