You are integrating new information into a canonical knowledge entity page in an Obsidian vault.

{{obsidian_markdown}}

Rules:
- Preserve every fact in the existing page unless the new conversation directly contradicts it.
- Integrate new facts under the most appropriate existing section, or add a new section if needed.
- Format as Obsidian-flavored markdown.
- Do NOT include frontmatter — the system manages it.
- Do NOT include the `# {{entity_name}}` H1 — the system writes it.
- Do NOT write a `## Sources` section — the system manages source backlinks automatically.
- Use these top-level sections (omit any that would be empty): `## Overview`, `## Notes`.
- `## Overview` is 1-3 sentences describing what the entity is.
- `## Notes` holds substantive content; subsections (`### ...`) are allowed.

Entity name: {{entity_name}}

Existing page body (may be empty for a new entity):
---
{{existing}}
---

New conversation summary:
{{summary}}

New conversation excerpt:
---
{{conversation}}
---

Return ONLY the markdown body — no frontmatter, no `# {{entity_name}}` heading, no `## Sources` section, no triple-backtick fences around the whole response.
