# `edit` — replaces the built-in edit tool

Same `path` + `edits[]` schema, plus:

- `files: [{ path, edits }]` — many files in one call
- Everything is dry run first: a bad edit in the middle writes nothing
- A non-unique `oldText` is an error with the match count, not a silent first hit
  (pass `replaceAll` when you mean it)
- Falls back to whole-line matching when only whitespace or smart quotes drifted
- CRLF files stay CRLF; per-file mutation queue is respected

The diff it prints is laid out against the width the row is actually given,
rather than word-wrapped as prose:

```
278              cachedWidth = undefined;
279-         }               │ 279+         },
280          handleInput(data: string) {
```

Context spans the full width once. Printing it twice, the way a graphical diff
viewer does, is the most expensive thing you can do to a 60-column pane and it
shows nothing. Only the changed lines take columns, and only when every line in
that run fits its column — a long line split in half wraps into ragged fragments
on *both* sides, which reads worse than not splitting at all. So one hunk can go
side by side while the hunk below it stays stacked. Runs that are pure insertions
or pure deletions never split; there is nothing to put opposite them.

Everything else follows from the width on the day: the gutter drops the line
number, then all but the sign, as the pane narrows; long lines hard-wrap at the
column with a `↳` and their original indent instead of reflowing at spaces; the
token that actually changed is picked out with a stronger background than its
row. `PI_DIFF_MODE=split|unified` pins the choice.

Both backgrounds are tints of the theme's `toolDiffAdded` / `toolDiffRemoved`,
sat a fixed distance in luma from the background — upward on a dark terminal,
downward on a light one. A theme naming a hex has already chosen its tint and
keeps it; the kit's own theme names ANSI slots, which are full-strength accents,
so the mix is made from what the terminal reports for that slot and its
background (`lib/ui/terminal-slot-colors.ts`) and follows a light/dark flip without a reload.

The layout lives in `lib/transcript/split-diff.ts` and is pure, so `npm test` renders every
fixture at 59, 97, and 161 columns — a herdr split, the pane beside it, and the
tab zoomed — and asserts the TUI's one hard contract, that no line is ever wider
than the width it was handed, across three modes and every width from 4 to 200.

The entry (`index.ts`) holds the schema, the words and `execute`;
`edit-text-matching.ts` finds each `oldText`, `edit-file-plan.ts` is the dry
run and the write, `lib/tools/edit-legacy-arguments.ts` takes the older argument shapes,
and `edit-tool-rows.ts` draws the call and the diff.
