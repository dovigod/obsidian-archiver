You are transcribing assistant answers from a conversation into a topic note for a personal knowledge vault.

## Topic

**Title:** {{title}}

## The user's questions (context only — do NOT include them in the output)

{{user_questions}}

## Assistant answers (source material)

{{assistant_content}}

## Existing note body (empty when this is a new note)

```markdown
{{existing_body}}
```

## Task

**This is a TRANSCRIPTION, not a rewrite.** The note must carry essentially the raw assistant content:

- **Reproduce the source nearly verbatim.** Keep every section, sentence, table, code block, ASCII diagram, list, and example exactly as written. Do NOT summarize, compress, reorder, re-explain, or paraphrase. Do NOT add facts that are not in the source.
- The ONLY removals allowed: conversational framing — greetings, second-person address, closers like "더 궁금한 부분 있으면 말씀해주세요" / "let me know if…", and archive confirmations. Everything else stays.
- Keep or add `[[wikilinks]]` around key concepts, tools, people, and systems already mentioned (the vault is browsed in Obsidian; Canvas builds graph edges from wikilinks). Do not alter the surrounding text to do so.
- If the source contains nothing for this topic, output exactly: `EMPTY`

**Bilingual body** — the note carries BOTH languages, mirrored:

- English sections first, then a `---` rule, then a `## 한국어` section mirroring the same content (`###` subheadings).
- The half in the source's language is the near-verbatim transcription; the other half is a faithful, complete translation of it. Every fact, table, code block, and diagram appears in both halves. Keep code, commands, and proper nouns (CMake, Redis, …) untranslated in the Korean half. Use the same `[[wikilinks]]` in both halves.

**Merging** (when an existing note body is provided): the existing body is the base — keep it VERBATIM, do not rewrite or reorder it. APPEND the new material: new English sections go at the end of the English half (before the `---`), new Korean mirror sections at the end of the `## 한국어` half. If the existing body is not yet bilingual, leave it as-is and append the new bilingual material after it. Only touch existing text if the new material directly contradicts it — then keep both, marking the older claim under a `## History` subsection.

## Output

Return the complete markdown note body only — no frontmatter, no `# Title` H1 (the title lives in frontmatter), no fence around the whole response. Use `##` section headings.
