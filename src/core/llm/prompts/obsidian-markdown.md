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

## Obsidian Canvas integration

This vault is opened inside Obsidian and the reader uses the **Canvas plugin** (`.canvas` JSON files that arrange notes as a visual graph) habitually. Write so pages drop cleanly onto a canvas:

- **Lead with a one-paragraph summary.** Canvas card previews show only the first few lines — if the page opens with a tight TL;DR (or short `## Overview`), the card is scannable at a glance.
- **Use Obsidian callouts for key claims**: `> [!note] …`, `> [!tip] …`, `> [!warning] …`, `> [!example] …`, `> [!summary] …`. Canvas renders callouts as visually distinct blocks, so the main idea is obvious without opening the card.
- **Be generous with `[[wikilinks]]`** to other entities. Canvas auto-discovers connections through wikilinks, so dense linking yields a rich graph automatically — link any time you naturally mention a related entity.
- **Use block-level embeds** (`![[Other Note]]` or `![[Other Note#Section]]`) when another note's content meaningfully belongs here. The reader can transclude a specific section onto a canvas without copy-pasting.
- **Keep H2 section names stable and meaningful** (`## Overview`, `## Notes`, `## Examples`, …). Canvas users frequently embed a specific section via `![[Note#Overview]]`; renaming sections breaks those references.
