You are integrating new information from a conversation into an existing entity page.

## Existing entity

**Name:** {{name}}

**Body (markdown):**

```markdown
{{existing_body}}
```

## New conversation excerpt

```
{{conversation_excerpt}}
```

## Task

Rewrite the entity body to integrate the new excerpt with the existing content. Preserve every fact already in the body unless the new excerpt directly contradicts it; in case of contradiction, prefer the more recent (new excerpt) version and mention the prior claim in a "## History" section if it was substantive.

## Output

Return the new markdown body only. No front-matter, no `# {{name}}` H1, no fence around the whole response — just the markdown body content (sections like `## Overview`, `## Notes`, `## Examples`, etc. are fine).

Rules:
- Keep section structure clean and Obsidian-readable.
- The body is BILINGUAL: English sections first (`## Overview`, `## Notes`, …), then `---`, then a `## 한국어` section mirroring the same content in natural Korean (`### 개요`, `### 노트`, …). Integrate the new excerpt into BOTH halves so they stay in sync — every fact must appear in both languages.
- If the existing body has no `## 한국어` section yet, add one translating the full (post-integration) English body. Keep code identifiers, commands, and proper nouns untranslated in the Korean half.
- Inline `[[wikilinks]]` to other entities you naturally reference; do not invent links to entities that haven't been mentioned. Use the same `[[wikilinks]]` in both halves.
- Stay within roughly the same length as the existing body unless the new excerpt genuinely adds substantial new material (the Korean mirror does not count against this).
- **Canvas-friendly output** — the reader habitually opens this vault inside Obsidian's Canvas plugin:
  - Keep the opening paragraph of `## Overview` short and scannable; Canvas card previews show only the first few lines.
  - Promote key claims to Obsidian callouts where they fit (`> [!note] …`, `> [!tip] …`, `> [!warning] …`, `> [!example] …`). Use them in BOTH language halves.
  - Be generous with `[[wikilinks]]` — Canvas auto-builds edges from wikilinks, so denser linking yields a richer graph. Don't fabricate links, but link freely whenever you genuinely mention a related entity.
  - Don't rename stable H2 headings (`## Overview`, `## Notes`, `## Examples`, …) — Canvas users embed specific sections via `![[Note#Overview]]`, and renaming breaks those embeds.
