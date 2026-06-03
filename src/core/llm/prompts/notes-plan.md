You are planning how to distill one archived conversation into topic notes for a personal knowledge vault.

A *topic note* is a standalone explanatory document (`notes/*.md`) that collects what the assistant taught about ONE broad theme. Notes are living documents: when the vault already covers a theme, new material is merged into the existing note instead of creating a new file.

## Conversation

{{conversation}}

## Existing notes in the vault

{{existing_notes}}

(Each line is `filename — title [topics]`. Empty means the vault has no notes yet.)

## Task

Group this conversation into topic notes. Rules:

- **Topics come from the USER's questions** — what was the user trying to learn or get done? Assistant detours and meta-chatter (archive confirmations, "let me know if…" closers) are not topics.
- **Merge aggressively; do NOT over-split.** Related questions belong to ONE group. Example: questions about MX records, SPF/DKIM/DMARC, and email IP reputation are ONE note ("Email DNS & deliverability"), not three. A typical conversation yields 1–3 groups, often just 1.
- **Prefer merging into an existing note** when its title/topics cover the same or a clearly similar theme — return `action: "merge"` with that note's exact `filename`. Only `create` when nothing existing fits.
- Skip groups with no substantive assistant content (e.g. the user only issued commands).
- `assistant_indexes` are 0-based indexes into the conversation's ASSISTANT messages only (the numbering shown in the transcript), listing which assistant turns carry the group's content.
- **`needs_canvas`** — set true when EITHER applies:
  - The user's questions suggest they found the topic hard to grasp: re-asking the same thing, "explain it simply/again", step-by-step requests, basic clarification questions.
  - The content explains an **overall flow, process, pipeline, or architecture** — a sequence of stages or interacting parts (e.g. "how does X work end-to-end?", configure→generate→build, a transaction lifecycle). Flows benefit from a diagram regardless of how confident the user was.
  A simple factual one-shot Q&A (definition, single fact, one command) is false.
- `title` and `topics` mirror the conversation's primary language (English ↔ Korean).

## Output

Return a single JSON object. No prose, no markdown fences.

```jsonc
{
  "notes": [
    {
      "action": "create",            // or "merge"
      "target": "Existing_Note.md",  // required when action is "merge"; omit otherwise
      "title": "Email DNS & deliverability",
      "topics": ["dns", "email", "deliverability"],
      "assistant_indexes": [0, 1, 2],
      "needs_canvas": false
    }
  ]
}
```

If nothing in the conversation is worth a note, return `{ "notes": [] }`.
