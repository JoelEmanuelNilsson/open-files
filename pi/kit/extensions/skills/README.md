# `skills` — which skills the model may reach for

`/skills`. A skill is always invocable by hand as `/skill:name`; what this
toggles is the other half — whether pi *advertises* it to the model, which is
one `disable-model-invocation` line in the file's frontmatter and about forty
tokens of name and description in every request. Twenty-eight skills is a
paragraph of standing context, so the question is worth answering in ten
seconds rather than across twenty-eight files.

Space toggles the row, `ctrl+s` writes, `ctrl+r` discards, `esc` cancels.
Typing filters. The glyph says what the draft wants and the `•` marker says
that draft differs from disk, because a dialog showing only one of them hides
either the pending edit or the current truth. **Declared limit: the filter
takes no spaces** — space is the toggle on every row, always, and a toggle key
that changes meaning depending on whether a text box is empty is a toggle key
that gets mis-pressed.

Three facts make it small. pi has already discovered and parsed every
`SKILL.md` and hands the complete set over as `getSystemPromptOptions().skills`
— muted ones included, each with its `filePath` and flag — so there is no
directory scan and no frontmatter *reader* here; a second one could only ever
disagree with the one that counts. The file stays the only state, so
frontmatter and behaviour cannot drift apart. And `ctx.reload()` exists, so
applying is one keystroke instead of two steps with a note in between.

Each file is re-read at apply time rather than snapshotted when the dialog
opened. That is the stronger guarantee, not the weaker one: an edit made in
another window meanwhile survives, because the patch lands on the newest bytes
instead of being refused against stale ones. The write is a same-directory temp
file, fsync, rename, with the original mode carried over.

The path is resolved through symlinks first, and on this machine that is not a
detail. `~/.agents/skills` *is* a symlink into `pi/kit/skills`, so pi reports
every skill's `filePath` through it. `rename` replaces the name it is handed:
aimed at a symlink it swaps the link for a regular file and severs the
checkout, leaving two copies to drift. Resolving first puts the temp file
beside the real file, on the real file's filesystem. `test/views/skill-file-apply.test.mjs` pins
both shapes — a linked directory and a linked file — and fails loudly without
the resolve. A failure names the resolved file too, because that is the one
you would have to go and fix.
