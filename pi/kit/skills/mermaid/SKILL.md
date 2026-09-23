---
name: mermaid
description: Create and validate Mermaid diagrams. Use when writing or editing a Mermaid chart in markdown, docs, or a .mmd file.
disable-model-invocation: true
---

# Mermaid

Never ship a Mermaid diagram you have not parsed. The syntax fails in ways that
look fine in a text editor and blank in a renderer.

## Prerequisites

Node and npx. The first run downloads a headless Chromium through Puppeteer; if
Chromium is missing, set `PUPPETEER_EXECUTABLE_PATH` to an existing browser.

## Workflow

1. If the diagram will live inside markdown, draft it in a standalone
   `diagram.mmd` first. The validator only reads plain Mermaid files.
2. Write or edit `diagram.mmd`.
3. Run the validator:

   ```bash
   ./tools/validate.sh diagram.mmd            # parse + render to a temp SVG
   ./tools/validate.sh diagram.mmd out.svg    # keep the SVG
   ```

   Non-zero exit means invalid syntax. The error message names the line.
4. Fix and re-run until it passes.
5. Copy the validated block into the markdown file.

The validator also prints an ASCII preview via `beautiful-mermaid` when the
diagram type supports it. Treat a failed preview as a warning, not an error.

## Things that break Mermaid

- Parentheses, quotes, or `<br>` inside node labels: wrap the label in double
  quotes, `A["Fetch (cached)"]`.
- A node id that collides with a keyword (`end`, `graph`, `class`, `state`).
  Lowercase `end` breaks flowcharts specifically.
- Semicolons after subgraph headers.
- Edge labels containing `|` or unbalanced quotes.
- Mixed diagram syntax: a `sequenceDiagram` body under a `graph TD` header.
- Comments must be `%%`, not `#` or `//`.
