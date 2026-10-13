# `transcript` — tool calls as receipts, not output

```
┊  the wrap has to happen after the render, not before

   Two things changed. Here is the first.

● Read(lib/transcript/split-diff.ts)
  ⎿  Read 412 lines

● Grep(renderCall in kit/)
  ⎿  Found 7 matches

● Bash(npm test)
  ⎿  > pi-kit@0.1.0 test · 2.4s
     > node test/suite-runner.mjs
     suite
     … +37 lines (ctrl+o to expand)

● Bash(cat nope.ts)
  ⎿  cat: nope.ts: No such file or directory
     Command exited with code 1
```

Claude Code's grammar, ported. Dot in column 0, name in column 2, argument in
parentheses, and a five-column `⎿` gutter under it carrying what came back.
Nothing is positional beyond those two columns, so a long tool name or a narrow
pane degrades instead of breaking a grid.

pi's own row is a `Spacer`, a padded `Box`, the call, and ten lines of whatever
the tool printed: four blank lines around one line of signal, whether the call
returned two hundred lines or nothing. Ten calls in a turn is forty blank lines.
The only thing separating a call that failed from one that worked is the box's
background, and the jarvis themes set all three of those to transparent, so the
state was invisible and the noise was not.

**The dot carries the state and never moves.** Dim while the call is in flight,
`success` when it settles, `error` when it fails. Claude Code blinks its pending
dot every 600ms; this one does not. Their renderer is a cell-grid compositor with
dirty tracking, pi's is not, and `ghostty/shaders/subtle-crt.glsl` already tints
glyphs by their row over a blurred translucent background, so a repaint
recomposites the blur to say something colour already said.

**Every settled call gets a result line.** That pairing is the whole readability
win, and it is what makes a row read as a receipt rather than a label. The number
in it is bold and the unit is not: `Read 412 lines`, `Found 7 matches`, `Listed
31 entries`, `Wrote 3 lines`.

**Counts never come from reading the output.** `read` is the file verbatim, and `write` is counted
from the content it was handed rather than the `Successfully wrote N bytes` line
it prints back. `bash` is not countable — its output is whatever the command
decided to print — so it shows the output itself instead.

**Which end of that output depends on whether the call is still going.** Running,
the row tails: the last line is where the command has got to, and a row showing
the first three lines of a build would sit on the banner for two minutes.
Settled, the row shows the *head* — three lines, then `… +37 lines (ctrl+o to
expand)` — because the answer starts at the top and the last line of a finished
command is usually a blank or something the exit code already said. Both ends
come out of one function, `outputPreview`, so they cannot drift into two ideas
of what a line of output is, and the key in that hint is read from pi's
keybinding registry rather than written down, so rebinding `app.tools.expand`
renames every hint in the transcript. Three is Claude Code's `MAX_LINES_TO_SHOW`.
A blank line never takes one of those three rows — three lines of a build log
spent on paragraph breaks say nothing — but it is still counted in what is left,
so `+N lines` is the number of lines below the last one on screen.

A count is computed once, when the result settles, and kept on `context.state`.
Not on `details`: that is a typed contract the UI and session logic read, and pi's
docs say an override has to match it.

**What is on screen is what is happening.** Not seven rows that fold up at the
end — that is a screen that jumps every time the agent stops — and not a
past-tense line that grows a clause every time a result lands, which narrates
the past while the work is still running. A run says what it is *doing*, and
what it has already done says nothing at all until the run is over:

```
❯ read the three files, grep for two things, list nested, run the two pings

● Searching for 2 patterns, reading 3 files, listing 1 directory, running 2
  shell commands…
```

One line for the whole batch, wearing the dot and the gutter of whichever call
is still speaking:

```
● Running 2 shell commands…
  ⎿  $ ping -c 25 127.0.0.1 > /dev/null
```

Both tenses count every call in the group, never the in-flight subset, so a
landing result takes no number down and settling puts none back.

The moment the last of them lands, all of it is replaced, in the same columns,
by the past tense over everything that folded:

```
  Searched for 2 patterns, read 3 files, listed 1 directory, ran 2 shell
  commands
```

The dot goes and no word moves: the two-space indent is exactly the dot and its
space. Nothing else moves either, because each call folded the moment its own
result arrived. This is Claude Code's behaviour, sampled off a pane two seconds
apart through a mixed batch rather than guessed at — work that finishes while
its own message is still running leaves nothing on screen, not a row and not a
clause — and pi needs it more than Claude Code does, since pi creates every row
of a batch as the arguments stream, seconds before any of them runs.

The same grammar as a result line — bold count, plain unit — with only the first
clause capitalised and the whole thing muted, because it is a receipt for work
you have stopped caring about. `read` counts files, `bash` shell commands. What it counts is *calls*,
not what they returned: `Read 2 files` is two rows that each said `Read 412
lines` on their own. `ctrl+o` puts them all back.

**A lone call is its own row while it runs, and one line once it is over.**
While you are waiting, pi knows the command and the path and `Running 1 shell
command…` says less than either, so nothing is folded away from work in flight.
When it settles it becomes `Ran 1 shell command` like any other group — Claude
Code's own rule, and what makes three silent shell commands in three messages
leave one line instead of three rows. `ctrl+o` opens it again.

**It is the one line that wraps.** Every header in the transcript is clipped,
because a header that can grow is a header you have to read to skip. This is a
sentence with a clause per tool, and clipping it drops the last clause, which is
the one thing on the line that cannot be guessed: a four-clause turn on an
80-column pane read `…ran 2 shell comm…` until it wrapped instead. Claude Code
wraps it to the same indent too.

**The live line carries a clock; the settled line does not.** Claude Code
ticks one on its running row (`Listing nested directory contents · 24s`) and so
does this (`Running 2 shell commands · 3.0s…`), owned by the group and painted
on the speaking row alone, so a silent command is visibly alive. The repaint
costs nothing new: the prompt frame already redraws its own clock once a second
for the whole turn. A settled line says what happened, never how long it took;
a settled row still shows `· 2.4s`, which is the number you can act on.

**A row that would still tell you something keeps it.** Anything that changed
something (`write`, `edit`), a call that failed, a call that was cut off
— hollow dot, no result, sitting where it stopped — a result carrying a picture
pi is going to draw anyway, and any tool with no verb in the table, MCP
included. Being in flight is only invisible while the run is live: once it is
over, a call that never came back was interrupted, and that is the record of
what happened — `esc` through a batch of three brings all three rows back with
their aborted results. Claude Code collapses failures too and
leaves the model's prose to explain them; this extension exists because a failed
call was invisible in pi's own rows, so hiding one behind `Ran 1 shell command`
is the one piece of the grammar not worth copying. A row that stays also breaks
the run, so a line only ever counts rows that were actually above it:

```
  Read 1 file, searched for 1 pattern

● Bash(cat nope.txt)
  ⎿  cat: nope.txt: No such file or directory
     Command exited with code 1

  Listed 1 directory

● Write(d.txt)
  ⎿  Wrote 1 line
```

**Adjacent means nothing was printed in between.** pi adds the whole assistant
message to the chat when the message starts and appends its tool rows after it,
so a message that says anything says it *above* its own calls whatever the order
of its content blocks: text ends a group and starts the next. So do a user
message, a compaction summary and an extension's own entry. A model change
prints nothing, so it does not.

**Thinking never breaks a group**, hidden or not — Claude Code skips thinking
blocks when it groups too. With `hideThinkingBlock` on, which is how this
harness runs, a reasoning model puts a block in front of nearly every message,
so counting one as prose made nearly every message a group of one: the rollup
line switched itself off for exactly the models that call the most tools.

**One planner, however many extensions borrow it.** pi loads each extension
file with its own jiti and no module cache, so `extensions/bash/index.ts`, which wears
this extension's receipt, holds its own copy of every module in it. The seats,
the redraw callbacks, the pending results and the clock therefore live on the
process (`lib/transcript/rollup-planner-state.ts`, keyed `Symbol.for("pi.kit.transcript
.state")`) rather than at module scope. With a map per copy, bash rows never
folded and a group led by one hid its members with no line to replace them —
output silently lost, and every test green, because the suite loads the kit
through a single jiti. `test/transcript/transcript-two-jitis.test.mjs` loads it through two.

**The grouping is read off the session, never guessed at.** `lib/transcript/rollup-plan.ts` is a pure
function from pi's own context entries to a list of groups, and it only ever
reads what has already happened: which calls a message made, in what order,
which have come back, and what was printed between them. It runs as each result
lands, again when the run settles, and again after a compaction, a fork or a
walk of the tree, since those rebuild every row from the session and the row
that was leading a group may be the one that just left the context. The same
function over the same entries is the whole of resume: a session loaded from
disk is a transcript of runs that all settled long ago, and the planner cannot
tell the difference.

Two facts reach it before the session has them, because pi tells extensions
first and writes afterwards: the message being streamed, whose rows are on
screen the moment its arguments arrive, and a result, which for a parallel batch
is not written down until the last call in the batch returns. Both are handed to
the planner directly rather than waited for.

That distinction is the difference between this and the version that was
deleted. An earlier one merged runs of the same tool onto one line by guessing at
`message_start` whether more calls were coming, and needed four hundred lines of
batch registry, revision stamps, resume seeding and abort quiescing to hold the
guess up — for a merge that fired on maybe a third of turns. Keyed on a turn
that has already happened, the same effect is one pure function, one map from
call id to seat, and no bookkeeping at all.

What draws the line is one row of the group: an extension cannot add a component
to the chat container, so the line has to come out of a row that is already
there. Every other row in the group renders nothing at all, and a row with
`renderShell: "self"` whose renderers produce no lines disappears completely —
no spacer, no blank, no gap. Which row it is follows the work: the first call
still in flight while the run is going, the first call of all once it is over.
Those are always the same place on screen, because everything before either of
them is folded and a folded row is zero lines tall, so a batch hands the screen
from one call to the next and finally to its own past tense without a word
moving. That row speaks for the group in the other direction too: it is the row
a pointer can reach, so opening it opens the rows behind it, which are zero
lines tall and can never be clicked.

**Durations under 500ms are not shown.** Claude Code shows no per-call duration
at all. This appends `· 2.4s` to the result line once the wait was long enough
that you felt it, and drops it again on a pane too narrow to carry both, so the
column stays quiet and a slow call stands out.

**The header is one line for every tool but the shell.** The argument is clipped
rather than wrapped, because a header that can grow is a header you have to read
to skip. Which end goes depends on which half identifies the call: a path keeps
its filename, a command keeps its program. `ctrl+o` wraps the whole thing and
opens the payload under it.

A shell command gets **two rows and 160 columns** — Claude Code's own
`MAX_COMMAND_DISPLAY_LINES` and `MAX_COMMAND_DISPLAY_CHARS`. It is the one
argument whose tail routinely carries the point, the redirect and the flag and
the path being written, so one clipped line drops exactly the half you would
have read second. The continuation sits under the open parenthesis, not under
the name, so it reads as more of the same call rather than a second one. Past
160 columns a header has stopped identifying a call and started reprinting it,
however wide the pane; `ctrl+o` still wraps the whole command.

**Paths are clickable, and the click lands in nvim.** An argument that is a path
gets an OSC-8 hyperlink, checked once per row and only once the file is really
there. A grep pattern that happens to look like a filename is not a path and
never gets one.

The link is not `file://`. macOS opens a file URL with whatever LaunchServices
thinks owns the extension, which here is QuickTime Player for `.ts`, TextEdit
for `.md` and a browser for `.json`, and a file URL has nowhere to put a line
number. So the rows link a scheme of their own:

```
pi-open:///Users/joel/dotfiles/pi/kit/lib/transcript/tool-row.ts?line=42
```

`~/Applications/Pi Open.app` claims `pi-open:` and runs `~/dotfiles/bin/pi-open`,
which splits the herdr pane that was clicked and opens nvim there — or reuses
the nvim it opened last time, over that nvim's own RPC socket, so ten clicks do
not make ten panes. Outside herdr it opens a Ghostty window instead. The line
comes from the call: `read` knows its `offset` before it runs, and `edit` learns
its `firstChangedLine` from the result and hands it to the header through the
state both render slots share.

`PI_TRANSCRIPT_OPEN=file` restores the old `file://` links, `off` drops links
altogether, and the default is `pi-open` only where that handler is installed.

**In fullscreen mode, a click on a result opens its row.** That is pi's own: `createResultRegion` toggles `expanded` on a left click (`tool-execution.js:112-116`), so the kit patches nothing for it. A folded group's line is opened with `ctrl+o`.

In regular mode there is nothing to hook: pi never turns mouse reporting on, so
the terminal owns the pointer — which is what gives you native selection and
real scrollback — and a row that has scrolled into the terminal's own scrollback
is not pi's to repaint. Switch modes in `/settings` to try the other trade.

**A call that was cut off stops saying it is running.** An interrupted row never
reaches `renderResult`, so its dot would stay dim forever — indistinguishable
from a call still in flight. On `agent_settled`, when nothing is in flight by
definition, every row still drawing as running turns hollow: `○`, dim, no result
line. It is the one state that changes the glyph rather than its colour, because
it is the one that has to be told apart from another dim dot.

**A failure keeps its output**, twelve lines of it, with the head elided rather
than the tail, because a stack trace ends with the reason and the reason is what
you looked for. `ctrl+o` shows all of it.

**An image is drawn by pi, not here.** `ToolExecutionComponent` adds inline
images as its own children, so a result slot that draws them too puts the same
screenshot on screen twice. The row says `Read image (2.4 MB)` and gets out of
the way. Under tmux, where `getCapabilities()` reports no image support, it falls
back to pi's own `imageFallback` line naming the format and size, since that is
then the only thing on screen.

**`edit` is in the same system.** It gets the header and keeps its own body
under the gutter: a diff under `● Edit(line.ts)` with `1 file, +12 −4` above it.
A diff floating at column zero beneath a header at column two reads as two
separate things. MCP tools are not reachable
— `pi-mcp-adapter` registers them itself — so that seam stays, and the fix for it
is a PR to the adapter rather than a wrapper fighting it over tool registration.

**Rows draw their own shell.** pi's default is a `Box` with a column of padding,
a blank line above and below, and a background the jarvis themes make
transparent; a two-line receipt inside it is five lines of mostly nothing.
`renderShell: "self"` gives one blank line above each row, which is the margin
Claude Code puts between its own groups. No prototype patch: the previous version
monkey-patched `ToolExecutionComponent.render` to strip a blank line, and that
went with the merging.

**Layout happens in `render(width)`, and is cached there.** Neither render slot
is handed a width, so every decision about what fits has to wait for the frame.
zen-chrome asks the TUI for a frame every 33ms while the agent works, and that
walks every component on screen, so each row keys its lines on the width and a
stamp of its own fields and hands back the same array until something moves.

`node test/preview/preview-transcript.mjs [width]` draws a screen of real rows through
pi's own `ToolExecutionComponent` with the real theme, which is the only thing
that proves what lands on screen.

The rows of `read`, `grep`, `find`, `ls` and `write` come from one
`registerToolRenderer` resolver. Only `write` is re-registered, with pi's definition
spread through it, because its `execute` makes the overwrite diff. pi accepts
stringified numbers in a built-in's arguments itself, so no coercion is wired in.

`PI_TRANSCRIPT=off` restores pi's rows everywhere, including `edit`.
`PI_TRANSCRIPT_OPEN=file|off` changes where a click on a
path goes.

## Traps

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
- **A renderer must not throw.** `test/transcript/renderers.test.mjs` hands the
  render slots a bare context with no `invalidate` and no `toolCallId`; pi
  prints the raw tool name when a slot throws.
- **Do not type at a reused nvim through herdr.** `pane run` and `send-text`
  deliver a bracketed paste, which lands in the buffer of a normal-mode nvim.
- **Ghostty eats a leading `+`.** `ghostty -e nvim +42 file` drops the `+42`;
  `-c 42` survives.
