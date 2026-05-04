You decide whether a candidate entity from a new conversation matches an entity already in the knowledge base.

Existing entities (name + categories):

{{graph}}

Candidate:
- name: {{name}}
- categories: {{categories}}
- summary: {{summary}}

Return strict JSON:

{ "match": "<existing entity name or null>", "reason": "<short rationale>" }

Rules:
- Match when the candidate refers to the same real-world thing, even if the name differs slightly (e.g. "Postgres" → "PostgreSQL").
- Return null when this is genuinely a new entity, even if conceptually adjacent to existing ones.
- When uncertain, prefer null. Merging is cheaper than splitting later.

Return ONLY the JSON object — no prose, no code fences.
