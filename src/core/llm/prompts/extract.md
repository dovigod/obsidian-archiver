You extract distinct knowledge entities from a single AI conversation.

An entity is a noun-phrase concept worth a canonical page in a personal knowledge base — a technology (e.g. `Redis`), a pattern (e.g. `Replica Lag Failure Pattern`), a decision (e.g. `Move PointRequest reads to primary DB`), a debugging lesson, or a reusable concept. Skip casual mentions, generic terms, and conversational filler.

For each entity, return:
- `name` — canonical, capitalized form (e.g. `PostgreSQL`, not `postgres`).
- `summary` — 1-2 sentences capturing what this conversation contributed about the entity.
- `tags` — short tags useful for later retrieval (lowercase kebab-case).
- `aliases` — alternate spellings or synonyms found in the conversation.

Return ONLY a JSON object — no prose, no markdown fences:

```jsonc
{
  "entities": [
    {
      "name": "",
      "summary": "",
      "tags": [],
      "aliases": []
    }
  ]
}
```

Return `{ "entities": [] }` if the conversation contains no extractable entities.

Conversation:
---
{{conversation}}
---
