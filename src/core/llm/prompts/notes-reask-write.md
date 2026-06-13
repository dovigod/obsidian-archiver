You are writing a topic note for a personal knowledge vault by **answering the user's questions yourself**, richly and completely.

This is NOT a transcription. The original assistant answers were lost to summarization, so you must **regenerate the full explanation from scratch** — produce the kind of thorough, well-illustrated answer the user originally received.

## Topic

**Title:** {{title}}

## The user's questions (answer THESE)

{{questions}}

## Context hints from the original conversation (reference only)

The lines below are compressed leftovers of the original answers. Use them ONLY to recover conversation-specific details that pure general knowledge would miss — e.g. specific tools, repo names, commands, or surprising findings the user and assistant arrived at. They are lossy hints, NOT the source of truth. Where they are thin, fill in from your own knowledge so the note is complete. Do not mention that they are summaries.

```
{{context_summary}}
```

## Task

Write a complete, self-contained explanatory note that answers the user's questions:

- **Be thorough and concrete.** Explain mechanisms, not just definitions. Use ASCII diagrams, tables, code blocks, and worked examples generously — exactly the kind of rich content that makes a reference note valuable. Preserve any conversation-specific detail surfaced in the context hints.
- Lead with a one-paragraph TL;DR so the Obsidian Canvas card preview is scannable.
- Use Obsidian callouts for key claims (`> [!note] …`, `> [!tip] …`, `> [!warning] …`, `> [!example] …`).
- Be generous with `[[wikilinks]]` around key concepts, tools, people, and systems (the vault is browsed in Obsidian; Canvas builds graph edges from wikilinks). Use the SAME wikilinks in both language halves.

**Bilingual body — Korean FIRST, then English.** The note carries BOTH languages, mirrored:

- Write the **Korean** version first (full, complete — `##` section headings).
- Then a single `---` horizontal rule.
- Then the **English** version under a `## English` heading, mirroring the SAME content (`###` subheadings).
- Every fact, table, code block, and diagram must appear in both halves. Keep code, commands, and proper nouns (Docker, Redis, iptables, …) untranslated in the Korean half.

## Output

Return the complete markdown note body only — no frontmatter, no `# Title` H1 (the title lives in frontmatter), no fence around the whole response. Use `##` section headings. If there is genuinely nothing to write, output exactly: `EMPTY`
