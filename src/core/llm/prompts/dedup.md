You are deduplicating entity candidates against a knowledge vault.

The extract step produced a `new_node`. A keyword-similarity prefilter found one or more existing `candidates` that might be the same thing. Decide whether the new node refers to any existing candidate.

## New node

```json
{{new_node}}
```

## Candidates

```json
{{candidates}}
```

## Output

Return a single JSON object:

```json
{ "match_id": "<existing entity id>" }
```

or, when the new node is distinct from all candidates:

```json
{ "match_id": null }
```

Rules:
- A match means the candidate and the new node refer to the **same underlying concept** — not merely a related concept. "Redis" and "Redis Cluster" are distinct entities; "Redis" and "redis-server" are the same.
- Prefer false negatives (`null`) over false positives. A wrong merge is hard to undo; a redundant page can be merged later.
- Output JSON only. No prose around it, no markdown fences.
