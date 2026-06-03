You are extracting reusable knowledge entities from a single Claude Code conversation.

An *entity* is a thing worth a standalone page in a personal knowledge vault — a tool, library, concept, system, technique, person, organization, debugging lesson, or workflow that the conversation explains, debates, or applies. Skip transient errors, one-off commands, generic English nouns, and named values (timestamps, file paths, version numbers).

## Conversation

{{conversation}}

## Output

Return a single JSON object matching this schema:

```jsonc
{
  "entities": [
    {
      "name":       "canonical entity name (e.g. \"Redis\", \"PostgreSQL\", \"Vector Database\")",
      "summary":    "one-sentence definition",
      "tags":       ["short", "lowercase", "tags"],
      "aliases":    ["synonyms", "alternate spellings"],
      "draft_body": "bilingual markdown body — English first (## Overview, ## Notes), then a ## 한국어 section mirroring the same content in Korean (### 개요, ### 노트). Used as the initial body when this entity is new"
    }
  ]
}
```

Rules:
- Use the SAME canonical name the user/community uses ("PostgreSQL" not "Postgres", "Redis" not "redis-server").
- `aliases` should include casual spellings and abbreviations users might wikilink (`[[redis]]`, `[[postgres]]`).
- `draft_body` is markdown only — no front-matter, no `# Title` heading.
- `draft_body` MUST contain both languages, in this exact structure: English sections first (`## Overview`, `## Notes`), then `---`, then a `## 한국어` section carrying the SAME content in natural Korean (`### 개요`, `### 노트`). Every fact must appear in both halves — neither language may contain information missing from the other. Keep code identifiers, commands, and proper nouns (Redis, SQLite, …) untranslated in the Korean half.
- `summary` stays a single English sentence (it feeds dedup/embeddings).
- **Canvas-friendly `draft_body`** — the vault reader uses Obsidian's Canvas plugin daily:
  - Open `## Overview` with a one-paragraph TL;DR so the Canvas card preview is scannable at a glance.
  - Use Obsidian callouts (`> [!note] …`, `> [!tip] …`, `> [!warning] …`, `> [!example] …`) for key facts so they render as distinct blocks on a canvas.
  - Be generous with `[[wikilinks]]` to other entities you mention — Canvas auto-builds edges from wikilinks, so denser linking yields a richer graph.
  - Reuse the same `[[wikilinks]]` in BOTH language halves so the graph is language-agnostic.
- If the conversation contains nothing worth saving, return `{ "entities": [] }`.
- Output JSON only. No prose around it, no markdown fences.
