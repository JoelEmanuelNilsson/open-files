---
name: design-page
description: Build one HTML page for Joel to design in the browser. Use when a design question needs his answer.
---

One page, one question. Joel designs the system and never reads code, so the page carries everything he needs and nothing else. Two readers at once: a stranger reads the pictures and understands what the thing is, why, and how it flows; Joel clicks any term and gets its full meaning, then picks an option. The page is conversation: it goes stale and is refreshed when reopened, never maintained.

## Build

1. Pin the question. One sentence, the decision this page settles. Two questions is two pages. The reader's own opening question is the h1.

2. Plan before HTML. Read [`reference.md`](reference.md) and choose the pictures: the one concrete instance first, then three to five pictures in story order, then Options with an Answer block per open question. Write the plan as a list of picture kinds with one line each. Gather the facts the pictures need, each with the command that printed it; what is not on disk is declared absent, never invented. Bulk reading goes to an Explore agent.

3. Copy [`template.html`](template.html) to `<page-dir>/index.html`. It already has the strip, the gaps block, the click panels, the dictionary rail, the tags, the theme toggle, the motion and the accessibility. Fill every `<!-- fill: -->` point and delete the specimens you do not use. Write the pictures into it. Write one entry per clickable term into the `explain` JSON block at the bottom, answering the panel questions in `reference.md`. Facts live on the page, tagged with their command; there is no `facts.md` or `explain.md`. For a full page built from the template, see the exemplar at `/Users/joel/2/.scratch/pages/2026-09-02-the-solution/index.html`.

4. Run `node ~/.agents/skills/design-page/check.mjs <page-dir>` from a repo with playwright. It screenshots 1920 and 1440 and prints the bar: no sideways scroll, under a thousand top-layer words, every term has an entry, every entry has a term, no placeholders left, every picture labelled, no kicker above a heading. Fix until `clear`. Then look at `shot-1440.png` once and do the mom test from `reference.md`. This is the whole verification loop; more screenshots buy nothing.

5. Open it and tell Joel in three lines what to look at first. He annotates with `/plannotator-annotate <page-dir>/index.html`; his marks arrive as the next message anchored by element text, which is why every picture carries an `aria-label` in plain words.

6. Revise, or write the decision into the project's ledger and log. Then the page retires.

Done when: the question has an answer in the ledger, or the page is open and waiting on Joel with its gaps listed at the top.

## Not

A report, a status board, documentation, a place for code. A page that is mostly cards of text is a document wearing a stylesheet; rebuild it around its pictures.
