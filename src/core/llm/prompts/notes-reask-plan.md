You are planning how to turn one archived conversation into topic notes for a personal knowledge vault.

You are given ONLY the USER's questions from the conversation (the assistant's answers are intentionally withheld — they will be regenerated later). Your job is to group those questions into a small number of topic notes.

A *topic note* is a standalone explanatory document that answers ONE broad theme the user was trying to learn.

## The user's questions (numbered)

{{questions}}

## Task

Group the questions into topic notes. Rules:

- **Topics come from what the user wanted to learn.** Ignore meta/command turns that are not knowledge questions — e.g. "archive this with the infra tag", "delete the duplicate raw and commit", "보여줘", "해볼까요?". Such turns belong to NO group.
- **Merge aggressively; do NOT over-split.** Related questions belong to ONE group. Example: questions about namespaces, cgroups, veth/bridge, NAT, and OSI layers are ONE note ("컨테이너 네트워킹"), not five. A typical conversation yields 1–3 groups, often just 1–2.
- `question_indexes` are 0-based indexes into the USER questions shown above (the numbering), listing which questions this group covers.
- Skip a group entirely if it would only cover meta/command turns.
- **`needs_canvas`** — set true when EITHER applies:
  - The user's questions suggest they found the topic hard to grasp: re-asking the same thing, "쉽게 설명", step-by-step requests, repeated clarification.
  - The content explains an **overall flow, process, pipeline, or architecture** — a sequence of stages or interacting parts (e.g. "how does X work end-to-end?", a request lifecycle, a packet's journey). Flows benefit from a diagram regardless of how confident the user was.
  A simple factual one-shot question (single definition or fact) is false.
- `title` and `topics` mirror the conversation's primary language (English ↔ Korean).

## Output

Return a single JSON object. No prose, no markdown fences.

```jsonc
{
  "notes": [
    {
      "title": "컨테이너 네트워킹",
      "topics": ["docker", "networking", "namespace", "nat"],
      "question_indexes": [1, 2, 3, 4],
      "needs_canvas": true
    }
  ]
}
```

If nothing in the conversation is worth a note, return `{ "notes": [] }`.
