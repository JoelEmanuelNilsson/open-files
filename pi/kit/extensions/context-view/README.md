# `context` — where the context window went

`/context` and `/context usage`. Started as `pi-context-view`; mine now.

Capture is passive: the first real turn of a runtime freezes the Initial
snapshot. Before one has run — a fresh session, and the first `/context` after
every resume, reload or fork — the view rebuilds the prompt and tool figures
from pi's own options and say `Extension additions were not observed`. Usage
numbers are unaffected either way.

It used to fill that window with a *silent probe*: an empty user message sent to
start an agent run, aborted at `turn_start`. It measured a quantity that is
always zero and raised pi's entire run lifecycle to do it, which six extensions
read as a real turn — the visible symptom being `zen-chrome`'s hidden
`Working...` row coming back for the rest of the session. Retired in issue 18,
along with 300 lines of state machine; `test/views/context-view-noninterference.test.mjs` keeps it retired.

## Where things are

`index.ts` wires the two listeners and the command. `context-command.ts` is
the `/context` grammar and opens a view; `initial-capture.ts` freezes the
Initial snapshot and builds the pi-native fallback; `system-prompt-measure.ts`
splits a prompt into measured items; `injection-snapshot.ts` holds the item types the usage
classifier reads; `context-usage.ts` classifies the snapshot and the session into usage
categories. The views are in `ui/`: `usage-view.ts` (map, legend, block stream,
block) with its legend, palette, formats, map and preview blocks beside it. It
scrolls with `list-navigator.ts`, sanitizes with `preview-text-sanitize.ts`, and opens through
`lib/ui/view-overlay.ts`. `test/views/context-view-render.test.mjs` pins
the render contract; `NOTICE.md` at the kit root carries the upstream attribution.
