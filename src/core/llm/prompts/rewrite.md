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
- Inline `[[wikilinks]]` to other entities you naturally reference; do not invent links to entities that haven't been mentioned.
- Stay within roughly the same length as the existing body unless the new excerpt genuinely adds substantial new material.
