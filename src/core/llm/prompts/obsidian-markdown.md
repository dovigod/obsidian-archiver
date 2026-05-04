# Obsidian Flavored Markdown reference

Adapted from `kepano/obsidian-skills` (MIT). Source: https://github.com/kepano/obsidian-skills

## Syntax

- **Internal links**: `[[Page Name]]` or `[[Page Name|Display text]]`
- **Embeds**: `![[Page Name]]`
- **Tags**: `#tag/sub-tag`
- **Frontmatter**: YAML at the top of the file between `---` markers.
- **Callouts**:
  > [!note] Title
  > body text
- **Headings**: `# H1`, `## H2`, etc. Reserve `# H1` for the page title.
- **Wikilinks to file paths**: `[[raw/conversations/2026/05/<id>|<label>]]`

## Conventions for entity pages in this vault

- One `# H1` matching the canonical entity name (the system writes this; do not include it in synthesized output).
- Top-level body sections in this order, omitting any that would be empty: `## Overview`, `## Notes`.
- The system manages a trailing `## Sources` section automatically — do not write one yourself.
