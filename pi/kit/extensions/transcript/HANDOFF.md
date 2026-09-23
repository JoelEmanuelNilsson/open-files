# transcript — handoff

`npm --prefix ~/dotfiles/pi/kit test` passes. [`../../README.md`](../../README.md)
describes the extension as it stands and why each decision was made; this file
is what the last sessions did and what is still open.

## What we are doing

Making pi's transcript read like Claude Code's: a turn should leave behind the
smallest true statement of what it did, and open up when you ask it to. Tool
calls are receipts, not output.

## Where we are

The rollup is built, and it says two different things depending on whether the
run it describes is still going. A settled run leaves the past-tense line; a run
in flight says what it is doing, with a gutter under it saying where it has got
to. The tense belongs to the run — present from the first call to
`agent_settled` — so a turn of any length is two lines that change words in
place and shrink once, at the end.

### The observation this is built on

Claude Code 2.1.248, one message, all in parallel: a 25-second ping, two greps,
three reads, one directory listing. Sampled off the pane every two seconds.

```
t=6s    ⏺ Running 2 shell commands…
          ⎿  $ ping -c 25 127.0.0.1 > /dev/null; echo slow
t=12s   ⏺ Listing nested directory contents · 6s
          ⎿  $ ls -la /private/tmp/cc-live/nested (3s)
t=30s   ⏺ Listing nested directory contents · 24s
t=36s     Searched for 2 patterns, read 3 files, listed 1 directory, ran 2 shell commands
```

Read it twice, because the second reading is the whole point. The greps and the
reads finished around t=5 and **left nothing on screen at all** — not a row, not
a clause, nothing — until the message ended at t=36. There is no line that grows
while the work runs. What is on screen mid-message is one thing: the calls that
are in flight, in the present tense, with an ellipsis.

Two in flight is a counted line with a dot and the gutter of one of them
(`Running 2 shell commands…`). One in flight is that call's own row. When the
message ends, all of it is replaced in place by the past-tense line over
everything that folded.

Ours used to grow a past-tense line under a running row instead:

```
  Searched for 2 patterns, read 3 files, listed 1 directory
● Bash(ping -c 12 127.0.0.1 > /dev/null; echo a)
```

Both halves of that are wrong. It narrates the past while the work is still
running, and the line is unbounded text on a fixed width, so a busy turn
truncated it mid-word: `…ran 3 shell comm…`.

What pi does now, same prompt, sampled off the pane every three seconds. This is
the thing to reproduce before changing any of it:

```
t=6s    ● Grep(alpha)
t=9s    ● Searching for 2 patterns, reading 3 files, listing 1 directory, running 2
          shell commands…
t=12s   ● Running 2 shell commands…
t=24s   ● Bash(ping -c 25 127.0.0.1 > /dev/null; echo b)
t=33s     Searched for 2 patterns, read 3 files, listed 1 directory, ran 2 shell
          commands
```

The row at t=6 is the first call, alone, while the rest of the batch is still
streaming its arguments; pi draws rows as they arrive and Claude Code does not,
so that second is the one place the two differ. Everything after it is the same
shape, and the dot on the t=9 line is byte-for-byte the dim of the dot on the
t=24 row.

### What that bought, beyond looking right

The live line is a function of the in-flight calls only, and the settled line is
a function of the session only. Those two facts stopped overlapping, which is
the bug class that ate two earlier passes: a live render that wanted the
session's opinion is a render that is a whole batch behind. It also deleted
`Plan.queued` — hiding is now group membership and nothing else.

The first cut of the rollup folded everything at `agent_settled`, which meant a
screen of rows and then a jump. Do not go back to that either: a call folds the
moment its own result lands.

## What the last sessions did

**Session 1 — the grammar.** One row per call, Claude Code's shape: static
three-state dot, five-column `⎿` gutter, bold count with a plain unit, `· 2.4s`
past a 500ms floor, live bash tail, `edit` and `todo` on the same system, MCP
left to `pi-mcp-adapter`. An earlier attempt at merging runs of the same tool
onto one line was deleted along with `rows.ts`, `block.ts` and `shell.ts`.

**Session 2 — clicking.** `pi-open:` links instead of `file://`, rows clickable
in fullscreen by wrapping `TuiAltScreen.handleViewportInput`, a cut-off call
turning hollow on `agent_settled`.

**Session 3 — the rollup.** Claude Code 2.1.247 was run in a herdr pane beside
this one and asked the same questions the last handoff listed, because the
observable behaviour is the spec and the binary is 222MB of minified Bun. What
it does, all of it reproduced by hand:

- Collapse happens when the **turn settles**, not when the next message starts.
- **One call collapses as readily as seven.** There is no threshold. (Ours
  disagreed with this until session 5 — see below.)
- `ctrl+o` is a global "detailed transcript" toggle and shows the ordinary
  `● Read(path)` / `⎿ Read 2 lines` rows.
- **Failures collapse too** — `Ran 1 shell command` for a `cat` that exited 1 —
  and the model's prose is left to explain them.
- **`Write` and `Update` never collapse**: their rows, diff and all, stay.
- The line is `Searched for 1 pattern, listed 1 directory, ran 1 shell command`:
  muted throughout, the counts bold in the same muted colour, indented two
  columns, no dot and no gutter, first clause capitalised and the rest not.
- It counts calls, not results, and `Glob` and `List` both say "directories".
- **A parallel batch of four shows one row, not four.** Sampled every seven
  seconds through a batch of sleeps, Claude Code had exactly one row on screen
  the whole time and no summary line until the end. That is the observation the
  second pass at this was built on.
- Claude Code also **hides the prose between the calls it folds**. This does not:
  an extension can only decide what its own rows draw, and hiding the model's
  words is not the same trade as hiding a receipt. A group therefore ends where
  prose starts, which keeps the line honest about the rows it replaced.

**Session 4 — the two tenses.** The rollup was right after a turn and wrong
during one: it grew a past-tense line while the work ran. Claude Code 2.1.248,
sampled every two seconds through a mixed parallel batch, does not — the frames
are at the top of this file. What that session changed:

- A group in flight speaks in the **present tense** and counts only the calls
  that are still running. `Running 2 shell commands…`, `Searching for 2
  patterns, reading 3 files, listing 1 directory, running 2 shell commands…`
- What the same group has already folded says **nothing at all** until the run
  is over. This is the observation, and it is the one that is easy to get wrong
  twice.
- **One call in flight is its own row.** Claude Code shows the model's one-line
  description there; pi has no such field, and the argument it does have is
  better than a count of one. Once it settles it folds like anything else
  (session 5).
- The two tenses land in the **same columns** — the dot and its space are the
  past tense's indent — so the swap moves no word.
- The line **wraps** now instead of clipping. Four clauses on an 80-column pane
  read `…ran 2 shell comm…`, and Claude Code wraps to the same indent.
- `Plan.queued` is gone. Hiding is group membership, and the live line is a
  function of what is in flight while the settled line is a function of the
  session, so the two never disagree.

**Session 5 — the receipts say more.** Four decisions, all from Claude Code's
de-minified source at `/Users/joel/Downloads/CC-src/` rather than from a pane:

- **A settled call with no honest count shows the head of its output**, three
  lines, then `… +37 lines (ctrl+o to expand)`. It used to show the last line
  and a bare `+N lines`. Claude Code's `OutputLine` → `utils/terminal.ts:71-113`,
  `MAX_LINES_TO_SHOW = 3`, same footer text. A running row still tails, because
  a tail is what progress looks like; `result.ts`'s `outputPreview` writes both
  ends so they cannot drift apart. The key in the hint comes from
  `keyText("app.tools.expand")`, never from a string here.
- **A shell command's header gets two rows and 160 columns**
  (`CC/tools/BashTool/UI.tsx:25-26`), continuation under the open parenthesis.
  Every other tool keeps the one-line rule.
- **The plan panel's collapse hint names its chord.** It read `└─  to expand`
  for two releases: `keyText` resolves a keybinding *id*, and `ctrl+shift+t` is
  a raw chord. `rawKeyHint` is the formatter for that, and one binding now feeds
  both the hint and `registerShortcut`.
- **A `$name` mention is one row**, `● Skill(design-page)`. It was pi's
  `SkillInvocationMessageComponent` — a padded `Box` under `CustomMessageComponent`'s
  `Spacer`, five rows to say one name.

Ours differs on one thing on purpose: **a failed row stays**, because this
extension exists because a failed call was invisible in pi's own rows. The live
line carries a clock, like Claude Code's, since the prompt frame already repaints
once a second during a turn.

**Session 5 — one planner, and two grouping rules that were wrong.** Three bugs,
all of them things the suite could not see because it loads the whole kit
through one jiti while pi gives every extension file its own.

- **The planner's state is on the process now.** `seats`, `redraws`,
  `arrivals` and the ticker in `group.ts`, and `inFlight` in `row.ts`, live
  behind `transcriptPlannerState()` in `planner-state.ts`, keyed
  `Symbol.for("pi.kit.transcript.state")`. pi loads each extension file with
  `createJiti(…, { moduleCache: false })`, so `extensions/bash.ts` — which owns
  the shell and borrows `receipt.ts` for its rows — had its own copy of
  `group.ts` with an empty `seats` map. `roleOf` answered `"row"` for every bash
  call: bash never folded, and when a bash row was a group's speaker the `read`
  rows behind it hid with no line to replace them, so output disappeared off the
  screen entirely. Any file that borrows a receipt now joins the same planner by
  construction. `test/transcript-two-jitis.mjs` loads the two extensions through
  two loaders and fails on both halves of that bug.
- **A settled group of one folds.** It used to keep its row forever, which is
  why three silent shell commands in three messages left three rows. In flight
  it is still its own row; the swap happens once, at settle, and moves nothing:
  one line in the same two columns becomes another. The exceptions are
  unchanged — `write`/`edit` and anything with no phrase never fold, a failed
  row stays, an image stays, a call the run left behind stays.
- **Thinking never breaks a group.** `speaks()` reads text blocks only, which is
  Claude Code's rule (`collapseReadSearch.ts:380` skips thinking blocks when
  grouping). With `hideThinkingBlock: true` a reasoning model put a thinking
  block in front of nearly every message, so nearly every message was a group of
  one and the rollup was switched off for the models that call the most tools.
  Text still breaks a group, thinking alongside text still breaks it.

**Session 6 — the block stopped bouncing.** A turn of consecutive shell
commands (separate messages, thinking between them) went 2 → 1 → 1 → 2 lines
per command. Claude Code's rule is in `components/MessageRow.tsx:118`: a
collapsed group is active while `hasAnyToolInProgress || (isLoading &&
!hasContentAfter)`, and its gutter is `latestDisplayHint`, taken from the tool
*input* and held by `useMinDisplayTime`. What changed here:

- **The tense is a property of the run.** `Group.running` replaced
  `Group.live: number[]`: true only for the trailing group of a live plan,
  false at `agent_settled`. Deciding it per result made the group go past tense
  in the gap between one result and the next call.
- **The line draws its own gutter.** `RollupLine` takes a hint and puts it under
  the sentence; `renderResult` returns `BLANK` for every folded row, so the
  result slot no longer takes part in a rollup. The hint is the newest named
  member's `$ command` or the path `describe.ts` would have put in its header,
  and never its output: a first cut preferred the member's last printed line,
  which put a random line of stdout under `Running 2 shell commands` — Claude
  Code builds `latestDisplayHint` from the tool input only (`commandAsHint`).
  `heldHint` moved onto the group at the same 700ms.
- **The speaker never moves**, and a group of one draws the line too, from the
  moment its arguments close.
- **A call joins the count when its arguments close**, for every clause rather
  than only the noun ones: pi seats a row on the first streamed token, and a
  count that moved then would be counting a call nobody can name.

Verified live, in pi, in a herdr pane, all of it re-run after session 4: a mixed
eight-call batch going `● Grep(alpha)` → four present-tense clauses wrapped over
two lines → `● Running 2 shell commands…` → `● Bash(ping …)` → the past-tense
line, with nothing moving at the end of the turn; a mixed turn splitting around
a failure and a `write`; three sequential silent messages merging into `Ran 3
shell commands`; a read of a PNG keeping its row while its neighbours folded;
`ctrl+o` opening and closing all of it; `esc` mid-batch bringing all three rows
back with their aborted results; and `pi --session …` rebuilding the whole
transcript from disk.

## Traps worth keeping

- **A hollow image is herdr, not this extension.** Three sessions tried to fix a
  screenshot that renders as a blank block the right height, and none of the
  causes were here. pi is correct: the row reserves the picture's height and
  puts a kitty `a=T` transmission with the full payload on the first of those
  lines. Herdr parses that sequence itself and throws it away unless
  `experimental.kitty_graphics = true` is in `~/.config/herdr/config.toml`; its
  API says so directly, `pane graphics require experimental.kitty_graphics`. The
  text fallback never fires either, because `TERM_PROGRAM=ghostty` is inherited
  into the pane and `getCapabilities().images` is therefore still `"kitty"`. The
  same bytes in a plain Ghostty window draw the picture. Dump the pty with a
  `pty.fork` harness and grep for `\x1b_Ga=T` before touching any renderer: if
  the payload is on the wire, the bug is downstream of pi.
- **Do not mine the binary.** `~/.local/share/claude/versions/*` is a 222MB Bun
  executable and the summary line is assembled at runtime. Run it in a pane and
  watch it instead; `herdr agent prompt … --wait` then `herdr agent read` is the
  whole loop, and `--format ansi` is how you read the colours off it.
- **Sample it mid-flight, not after.** Everything session 4 fixed is invisible
  in a finished transcript: prompt without `--wait`, then `herdr agent read
  … --source visible` in a loop every two seconds. Two seconds, not seven — the
  earlier seven-second sampling is what let the wrong live behaviour stand.
- **Claude Code will not sit still for a `sleep`.** It backgrounds long sleeps
  or refuses them outright, and then the batch you were watching is gone.
  `ping -c 25 127.0.0.1 > /dev/null` is a slow foreground command it will run.
- **The rows are not layout boxes.** `Container` has no `LAYOUT_NODE`, so the
  layout tree stops at the document container. `click.ts` walks children and
  measures instead.
- **A container that is not the sum of its children ends that descent.** Past a
  `Box` with padding the line arithmetic is wrong, so `rowAtLine` stops rather
  than guessing.
- **A collapsed row must draw nothing from both slots.** `renderShell: "self"`
  drops the whole component when its renderers produce no lines — but pi still
  draws inline images as children of the row, which is why a result carrying a
  picture is never collapsed.
- **The speaker's `expanded` is the group's.** Members are zero lines tall, so no
  pointer can ever reach them; if they voted on their own visibility, a click
  on the line after a `ctrl+o` would leave a rollup line with full rows under it.
- **The speaker is the group's first row, always.** It used to walk to the next
  call in flight as results landed, which is a different component under the
  cursor mid-batch for no gain: every row before it is folded and a folded row
  is zero lines tall, so the line is in the same place either way.
- **A group object per plan, never mutated in place.** `regroup` compares the
  old seat with the new one to decide what to redraw, so a reused object whose
  `running` flag changed would report that nothing changed. What is carried
  across is `expanded`, the group's start time and its hint hold, and onto a
  group that grew as well as one that is identical: a batch gains a member on
  every streamed call, and an opened group that shut itself on the next token
  could not be clicked back open.
- **pi tells extensions before it writes anything down.** The assistant message
  is not in the session during its own `message_end`, and a parallel batch holds
  every result message back until the last call returns. Both facts are handed
  to the planner directly; a plan that waits for the session is a plan that is a
  whole batch behind.
- **pi creates a row when the arguments stream, not when the tool runs.** That
  is why the fold has to start at `message_update` and cannot wait for
  `tool_execution_start`. It is also why a batch shows one row, then a
  two-clause line, then a four-clause one over the second or so its arguments
  take to arrive: each of those is true when it is drawn, and the alternative is
  guessing at `message_start` how many calls are coming, which is the four
  hundred lines this file replaced.
- **A comma is not a word.** The rollup line is the one line that wraps, so each
  comma is welded to the word before it in `pieces`; as its own run it would
  wrap onto the start of a line.
- **A renderer must not throw.** `test/render.mjs` hands the render slots a bare
  context with no `invalidate` and no `toolCallId`; pi prints the raw tool name
  when a slot throws.
- **Do not type at a reused nvim through herdr.** `pane run` and `send-text`
  deliver a bracketed paste, which lands in the buffer of a normal-mode nvim.
- **Ghostty eats a leading `+`.** `ghostty -e nvim +42 file` drops the `+42`;
  `-c 42` survives.

## What is still open

- **Nothing in the kit runs `tsc`.** There is no tsconfig and no typescript
  dependency, so the jiti-based tests are the only check the code gets on its
  own. A check can be borrowed, and it is worth doing before handing off:

  ```bash
  TSC=$(ls -d ~/.npm/_npx/*/node_modules/typescript | head -1)
  node $TSC/bin/tsc --noEmit --strict --skipLibCheck \
    --target ES2022 --module ESNext --moduleResolution bundler \
    --allowImportingTsExtensions --noUnusedLocals --noUnusedParameters \
    extensions/transcript/*.ts
  ```

- **Nine strict type errors** remain in `extensions/`, all pre-existing, all in
  `todos`/`multi-edit`/`btw`. `transcript/` is clean, measured rather than
  assumed. The last handoff claimed the same and was wrong: `BLANK` was declared
  twice, in `header.ts` and `index.ts`, and neither satisfied `Component`, which
  wants an `invalidate`. It never threw because every container between a
  renderer's component and the root calls `child.invalidate?.()`, so the bug was
  invisible to the tests and to the screen. It lives in `row.ts` now, once, with
  a no-op `invalidate`.
- **MCP rows never collapse**, because `pi-mcp-adapter` registers those tools
  itself and nothing here knows what verb they deserve. A phrase table entry per
  MCP tool would be guessing.
- **The duration rides the first preview line**, `⎿  line one · 2.4s`, which
  can read as if it belonged to that line of output. It is the same column every
  other receipt puts it in, and moving it to the footer would hide it whenever
  nothing is hidden. Left where the eye already looks for it.
- **A collapsed preview line is clipped, not wrapped.** Three source lines must
  stay three rows at every width, or a narrow pane turns a three-line preview
  into twelve. Expanded wraps, because that is the mode that asked for all of it.
- **A rollup line carries no duration.** Claude Code ticks a clock on its live
  row and shows nothing on its settled line; this shows nothing on either, since
  a ticking clock is a repaint a second under a shader that recomposites a blur.
  If a turn's total wait ever wants saying, the group already knows every row's
  clock.
- **A group draws nothing at all until its first call's arguments close.** A
  call nobody can name is counted by no clause, so a group of one that is still
  streaming has an empty sentence and an empty gutter. That is one shrink-free
  gap of a few hundred milliseconds after the model's prose; drawing the
  half-typed command there is the alternative, and it moves.
- **The present tense starts at the streamed call, not the started one.**
  `Running 2 shell commands…` can be a second early, since pi creates a row when
  the arguments arrive and runs the tool just after.

## How to look at it

```bash
node test/preview-transcript.mjs 100        # real rows, a settled turn, a turn in flight
PI_PREVIEW_EXPANDED=1 node test/…           # what ctrl+o shows
npm test                                    # includes test/click.mjs

open 'pi-open:///etc/hosts?line=3'          # the click, without the click
tail -f ~/.cache/pi-open/log
```

`/settings` → TUI mode → fullscreen turns on clickable rows.
