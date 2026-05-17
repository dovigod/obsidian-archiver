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
      "draft_body": "markdown body (## Overview, ## Notes — used as the initial body when this entity is new)"
    }
  ]
}
```

Rules:
- Use the SAME canonical name the user/community uses ("PostgreSQL" not "Postgres", "Redis" not "redis-server").
- `aliases` should include casual spellings and abbreviations users might wikilink (`[[redis]]`, `[[postgres]]`).
- `draft_body` is markdown only — no front-matter, no `# Title` heading.
- If the conversation contains nothing worth saving, return `{ "entities": [] }`.
- Output JSON only. No prose around it, no markdown fences.
