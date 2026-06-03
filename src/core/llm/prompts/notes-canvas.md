You are designing a small concept map for this topic — either because the reader struggled with it, or because it describes an overall flow/process/architecture that benefits from a diagram. The map becomes an Obsidian Canvas; you output only the logical graph — the server handles layout and coordinates.

## Topic

**Title:** {{title}}

## Note body

```markdown
{{note_body}}
```

## Task

Break the topic down into the pieces the reader found hard. 4–12 nodes:

- `kind: "step"` — one stage of a process/flow, in order (e.g. "1. 지갑이 UTXO 선택 → 서명").
- `kind: "concept"` — a building block or definition (e.g. "UTXO = 미사용 출력, 디지털 동전").
- `kind: "example"` — a concrete example or analogy (e.g. "5만 원권으로 3만 원 결제 → 거스름돈").

Rules:
- Labels are short (one line, ≤ 80 chars), in the note's primary language.
- Edges connect related nodes; give an edge a `label` only when the relationship needs naming ("includes", "검증 후").
- Steps should chain in order: step1 → step2 → step3 …
- Every node id must be unique; every edge must reference existing node ids.

## Output

Return a single JSON object. No prose, no markdown fences.

```jsonc
{
  "nodes": [
    { "id": "utxo", "label": "UTXO = 미사용 출력 (디지털 동전)", "kind": "concept" },
    { "id": "s1", "label": "1. 지갑이 UTXO 선택 + 서명", "kind": "step" }
  ],
  "edges": [
    { "from": "utxo", "to": "s1", "label": "입력으로 사용" }
  ]
}
```
