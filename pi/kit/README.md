# pi-kit

Everything pi loads: the extensions in `extensions/` and the skills in `skills/`. A local
package, installed by path, so editing a file and running `/reload` is the whole
loop. The rules the code keeps are in [`ARCHITECTURE.md`](ARCHITECTURE.md);
where the kit's code came from is in [`NOTICE.md`](NOTICE.md).

A typed `/reload` while agents run is refused with their names; `/reload --force`
reloads anyway. pi has no hook that can cancel a reload (`session_shutdown` only
notifies), so a reload from code (`ctx.reload()`) is not guarded and stops them.

```bash
npm test          # the edit engine, the transcript rows, render paths
```

Every test file ends with a `N passed, M failed` trailer, so the suite reports
its own size and nothing has to count it by hand. `test/suite-runner.mjs` finds
them (`test/support/suite-files.mjs` says which files are suite files) and runs
them in parallel, each with its own state directory and a timeout; `npm test --
name` runs only the files whose path contains `name`. Two rules hold there:

- **One file's verdict never decides whether another file runs.** The suite
  used to be ten `node test/…` calls chained with `&&`; a stale check in
  `smoke.mjs` took 517 checks dark and nothing said so.
- **Nothing red is optional.** The suite once had a second, softer red for the
  pinned Claude Code release no longer being the installed one. That pin is
  gone: the version is read off the installed binary, so it cannot fall behind,
  and every remaining oracle checks the *structure* of the wire — a real bug in
  our mimicry when it moves, so it fails the run.

Skipped checks still count toward the suite's size, so the number
the HTML pages carry is a property of the code and not of the machine that ran
it.

`package.json` names two directories and nothing else, so a new file in
`extensions/` or `skills/` is picked up without touching the
manifest. Helpers that are not extensions live in `lib/`, out of the scan.
Disable individual pieces with `pi config`.

## Layout

Paths are relative to `pi/kit/`.

- `extensions/` — pi entry points only: `<name>.ts`, or `<name>/index.ts` with
  the extension's private modules and its `README.md` beside it.
- `lib/<domain>/` — code two or more entry points share, and the contracts
  between extensions: `agents`, `cache`, `models`, `process`, `session`,
  `tools`, `transcript`, `ui`, `wire`, `workflow`.
- `bin/` — command-line tools over the kit and its traces (`pi-prompt.mjs`
  renders a seat's first request offline; `pi-recall.mjs` reads an old
  session's raw history). `pi-try`, which runs another checkout as the live harness,
  is in the repo's top-level `bin/`.
- `skills/` — the skills, below. `themes/` — the TUI theme.
- `test/<domain>/<concept>.test.mjs` — the suite; `test/support/` holds its
  fakes and harnesses, `test/preview/` scripts that draw real rows.

## Index

Each extension's doc sits beside its code. The ones with no folder are
described here.

| extension | what it does |
|---|---|
| [`agent-dock`](extensions/agent-dock/README.md) | background agents, counted in the rule |
| [`agent-engine`](extensions/agent-engine/README.md) | the owned agent engine |
| [`agent-rows`](extensions/agent-rows/README.md) | subagents in the same receipts as everything else |
| `bar-light` | tells the status bar an agent is waiting on you (header of `extensions/bar-light.ts`) |
| [`bash`](extensions/bash/README.md) | the kit's own shell, in Claude Code's shape |
| `compaction` | writes pi's in-place compaction summary from the cached prefix, Joel's messages pinned (header of `extensions/compaction/index.ts`) |
| `compact-at` | `/compact-at 300k`: sets main's compaction threshold for the model, through the global settings file and a reload (header of `extensions/compact-at/index.ts`) |
| [`context-view`](extensions/context-view/README.md) | `/context`: where the context window went |
| `deferred-tools` | the prompt names each deferred tool and says `tool_search` loads it (`extensions/deferred-tools.ts`) |
| `git-settle` | clears the stale "modified" mark git leaves after pi rewrites `settings.json` (header of `extensions/git-settle.ts`) |
| [`model-catalog`](extensions/wire/README.md#model-catalog--the-releases-this-process-is-allowed-to-have) | the releases this process is allowed to have |
| [`multi-edit`](extensions/multi-edit/README.md) | `edit`: replaces the built-in edit tool |
| [`notify`](#notify--desktop-ping-when-pi-is-waiting) | desktop ping when pi is waiting |
| [`prose-links`](#prose-links--a-path-in-a-message-opens-in-nvim-not-textedit) | a path in a message opens in nvim, not TextEdit |
| [`quiet-thinking`](#quiet-thinking--hidden-thinking-draws-nothing) | hidden thinking draws nothing |
| [`side-chat`](#side-chat--btw-a-side-thread-under-the-main-chat) | `/btw`, a side thread under the main chat |
| `skill-mentions` | `$name` pulls a skill into the turn (header of `extensions/skill-mentions/index.ts`) |
| [`skills`](extensions/skills/README.md) | which skills the model may reach for |
| [`tool-call-guard`](extensions/tool-call-guard/README.md) | no scan starts at `/` |
| [`transcript`](extensions/transcript/README.md) | tool calls as receipts, not output |
| [`watchdog`](extensions/watchdog/README.md) | nothing waits forever |
| [`wire`](extensions/wire/README.md) | everything this harness puts on the Anthropic wire |
| [`workflow`](extensions/workflow/README.md) | one child per item, only the return value comes back |
| [`zen-chrome`](extensions/zen-chrome/README.md) | the prompt is a box |

Shared code with a doc of its own: [`lib/process/`](lib/process/README.md),
what one pi process shares. Kit-wide rules that are not layout:
[instruction text changes only with its pins](extensions/wire/README.md#instruction-text-changes-only-with-its-pins),
[one writer per shared surface](#one-writer-per-shared-surface).

---

## `side-chat` — `/btw`, a side thread under the main chat

Ask a side question while the main task keeps running. The side thread sees
main's context; main never sees the side thread.

- `/btw` (or `alt+s`) toggles side mode. `/btw <text>` enters it and asks.
  `/btw clear` starts the side thread over. While an agent is focused (below),
  `/btw` and `alt+s` switch to side mode instead of toggling it off.
- Entering appends a green `<SIDE-CHAT-STARTED>` line under main's chat, then
  the side turns, drawn like ordinary chat. Main keeps working; its new output
  lands above the marker. The prompt box shows a bold green `[SIDE]` at the left
  of its top edge, and in the folded row when the prompt is empty.
- In side mode a plain submit goes to the side thread. While a side answer runs,
  Enter steers it and the follow-up key queues after it, as on main. Slash
  commands and `!bash` act on main as usual: pi runs its built-in commands
  before any `input` event, so they never reach the side thread. A `/` text pi
  does not run itself (a pasted path, a skill, a template) is an ordinary
  submit and goes to the side.
- While main compacts (or summarizes a branch for `/tree`), Enter and the
  follow-up key hold every non-empty submit, `/` commands and paths included:
  pi would run some of them and queue the rest for main without an `input`
  event, and the extension cannot tell a built-in from a pasted path. The text
  stays in the editor with a notice; send it again when compaction is done.
  Enter on `!cmd` (bash on main), Enter after `\` (a newline), an empty
  submit and an open autocomplete keep pi's behaviour.
- Esc stops a running side answer; otherwise it leaves side mode. It never
  aborts main. Leaving (Esc, or `/btw` / `alt+s` toggling off) removes the
  marker and the side turns from the screen and aborts a side answer still
  running. Switching to an agent is not leaving: a running side answer keeps
  running, and its turns are there when you come back.
- The side thread lives in memory: it survives toggling, and is dropped on exit
  and on `/new`, `/resume` and `/fork`. Nothing is written to the session file.
- Each side question sees main's context as it is at submit, cut at the last
  complete point (no tool call without its result, no half-written reply), then
  the side turns so far, then the question. Same model as main, at main's current
  thinking level.
- Only `read` and `web_search` run, at most 8 tool rounds per side question —
  each round re-reads main's whole prefix, so cost grows with rounds and 8 covers
  a few reads and a search. Every other tool call is refused, and the side
  question's wrapper says so.

**How the cache stays cheap.** A side request is main's last request, copied:
`wire` publishes main's exact last provider payload, and its side branch sends a
clone of it with only `messages` replaced. `system`, `tools`, `thinking`, TTLs
and headers (main's session id, billing header and identity included) are main's
bytes, so the tools and system cache entries are main's. The side's messages
start with main's transcript, byte-equal to main's up to main's message
breakpoint. Four breakpoints: system and last tool (main's), an anchor on the
block main had its message breakpoint on — a cache read of main's whole prefix —
and one on the side's last block, which writes only the side turns. Each side
user message is wrapped identically on every request (the wrapper is applied at
request time, never stored), so a side follow-up reads the earlier side turns
too. Tools always come from main's payload, since tools sit before messages in
the prefix and any difference would invalidate everything after them; execution
is restricted separately.

**The agent view.** Enter on an agent in the dock's list (`↓` at an empty
prompt) closes the list and focuses the prompt on that agent. Unlike side mode,
which appends below main's chat because a side question is about main, the
agent view replaces main's transcript: the screen shows only an accent
`<AGENT worker-2 · audit the wire>` line, the agent's conversation and its
status rows, with a bold accent `[worker-2]` in the prompt box and `worker-2`
as the bottom rule's left label in place of the branch (the model, context,
clock and cost there stay main's). Leaving brings main's transcript back as pi
left it, including anything main wrote meanwhile, scrolled to the bottom. The
thread screen takes pi's header, resources and chat containers out of the
document and puts the same objects back; pi holds each in its own field and
never reaches them through the document, so nothing it writes while they are
hidden is lost. Side mode and the agent view are one screen with a placement
setting (`below` or `replace`) on the target. It follows the agent by task id, so a resumed agent's new run shows in
place. Under the feed: a dim `…` while the agent has shown nothing yet,
`↳ queued: <text>` for a message sent into a running answer until the agent
takes it, and `✓ done`, `✗ <error>` or `■ stopped` once it settles, with the
conversation kept on screen. A plain submit goes to the agent (steer while it
runs, resume once it has settled); the follow-up key queues after its current
answer while it streams, and is Enter otherwise. Text only: a submit with
images is refused and the text put back. A `$skill` mention is not expanded
for an agent. Esc leaves the view and never stops the agent (`x` in the list
does); `↓` reopens the list on the agent last focused, with a `main` row first
(`working` or `idle`) whose Enter leaves the view like Esc, and Enter on
another agent switches. An agent with no live session shows its transcript read from
its session file.

The side thread runs in one long-lived child session holding only side turns,
loaded with an explicit extension list (`wire`, `transcript`, `pi-web-search`
and the side thread's own guard), so none of the kit's other extensions run in
it. Side mode and the agent view are two targets of one prompt focus
controller (`extensions/side-chat/prompt-focus-controller.ts`), which owns
mounting, input, Esc, the follow-up key and the compaction hold for both; the
dock reaches it through `lib/session/prompt-focus.ts`. `lib/session/prompt-target.ts` holds the
one target per main session; `zen-chrome` draws `[SIDE]` or `[<agent>]` from
it, and `agent-engine` and `skill-mentions` ignore a submit it claims, because
pi runs `input` handlers in unsorted load order and a claimed submit must not
interrupt main's waits or load a skill into main.

Declared limits:

- The side request reads cold (no anchor) when main has sent no request in this
  process, main is not an `anthropic-messages` model, the side model differs
  from main's last request, or main's transcript no longer matches that request's
  prefix (compaction, tree navigation). Wire says so once (`wire:side-prefix`).
- On models without managed effort, the side request's `thinking` is main's as of
  its last request, not the current level.
- Side spend is not in `/stats`: `agent-dock` does not run in the side session.
- Inline (non-fullscreen) TUI mode redraws the whole screen on toggle, and on
  entering or leaving the agent view.
- `alt+s` needs the terminal to send Option as Meta on macOS.
- pi does not expose `isCompacting` to extensions, so the hold follows its
  compaction and tree events. Two short gaps remain where a side submit still
  queues for main: while pi resolves the summarization key, before
  `session_before_compact`, and after `session_compact` until pi clears its
  flag. With `shift+enter` bound to submit, pi's `\`+Enter submit is not held.
- A tool the side session does not register gets pi's generic `not found`; the
  wrapper tells the model why.

## `notify` — desktop ping when pi is waiting

Fires on `agent_settled`, skips turns under 12s. macOS only, through osascript.
`/notify test|mute|unmute`, `PI_NOTIFY_MIN_SECONDS`.

## `prose-links` — a path in a message opens in nvim, not TextEdit

The transcript's rows link `pi-open:`. Prose did not, and it is rendered by pi rather
than by anything here: a markdown link's target is written to the terminal
verbatim, so `[README](/Users/joel/…/README.md)` reaches macOS as a bare path
and LaunchServices opens it in whatever owns `.md`. With a window manager that
follows focus, clicking a path in the terminal then drags you into the room
TextEdit's window happens to be in.

`pi.registerMarkdownTransformer` is the seam — it sees user text, assistant
text and thinking, before pi renders any of it. Targets naming a local file
(`/abs`, `~/`, `file://`) are rewritten through the transcript's own `linkTo`,
so both kinds of click land in the same nvim and `PI_TRANSCRIPT_OPEN` governs
both. `:42`, `#L42` and `?line=42` all arrive as a line number.

Everything else is left exactly as written: other schemes, relative targets,
anchors, and anything inside a code span or a fenced block — a `](…)` in those
is text being shown, not a link being made. Streaming updates are skipped; the
finalized message is transformed again, and that is the one under the mouse.

Display only. The session and the model context keep the original text.

## `quiet-thinking` — hidden thinking draws nothing

With the thinking block hidden, pi still spends two lines on every reasoning
run: a blank line and the word `Thinking...`. On a thinking model that is a
stub above every message and above most tool batches, saying what the spinner
already said and pushing the work off the top of the pane.

Both lines come from one method. `AssistantMessageComponent.updateContent`
counts a thinking block as visible content, which buys the leading blank, and
then draws the label for each run of them. `ctx.ui.setHiddenThinkingLabel("")`
is not the fix: `theme.fg` wraps even an empty string in escape codes, so pi's
`Text` is handed something non-empty and draws a line anyway — the word goes
and its line stays, which is **two** blank lines instead of one and a word. pi
also resets that label whenever it rebinds a session, so the setting would not
survive a `/reload`.

So the fix is upstream of the drawing: one wrapper on `updateContent` hands the
original a message with the thinking content filtered out, and the component
never sees a thinking block while it is hiding them. No blank, because nothing
visible is left to space; no label, because the branch that draws it is never
reached. Every other branch of that method — text, tool calls, `length`,
`aborted`, `error` — runs on pi's own code over pi's own content, and with the
block *shown* the message is passed through untouched and pi renders it byte
for byte as it always did. Same seam and same style as `zen-chrome/user-message.ts`.

The unfiltered message is parked on the component under a global symbol, so
turning the block back on mid-session shows the reasoning that was hidden, and
a `/reload` — which builds a new copy of this module with new module state, but
leaves the components on screen alive — finds it there.

**Declared limit: thinking draws nothing, including when it sits between two
runs of prose in one message.** Those two runs then close up, because the blank
line under them was the thinking block's own. A rule with a "sometimes it
leaves a blank" clause is a rule you have to read the reasoning to predict.

**One exception: thinking in progress.** While the message is streaming and its
last block is thinking, the component ends with a blank line and the thinking
strip (`lib/ui/thinking-strip.ts`): `▱▱▱▱▱▱▱`, the effort slider's notches with a
slow wave through them and the model label's level-change light passing over
at a third of its tempo. It shows the model is working and goes the moment the
next block starts or the message ends, so finished thinking still draws
nothing.

`test/transcript/quiet-thinking.test.mjs` pins the four facts about pi the wrapper depends on —
the method name, the flag name, that an unpatched pi really does draw the blank
and the label, and that an empty label draws two blanks — and fails naming the
file in pi's dist that moved, because a wrapper whose seam has been renamed
goes quietly inert. `PI_QUIET_THINKING=off` restores pi's `Thinking...`.

## One writer per shared surface

The one-owner rule `wire` keeps for `before_provider_request` generalises
past the wire, and it has cost twice now, so it is written down. **No
extension writes another extension's UI state — publish the fact, never poke
the flag.**

pi's UI setters are write-only and absolute: `setWorkingVisible(visible)` has no
getter, so a second writer cannot save what it is about to overwrite and cannot
restore it. It can only guess, and its guess is pi's default rather than the
owner's choice — which is how `/context` used to un-hide `zen-chrome`'s
`Working...` row permanently (issue 18). Correct save/restore is not merely
unwritten there, it is unbuildable, so exactly one extension owns each setter.
An extension that needs another's behaviour to change publishes the fact that
should change it — the `globalThis` seam `lib/session/prompt-target.ts` and
`lib/cache/cache-window.ts` use — and the owner decides.

## `skills/`

Thirty-five skills in five layers. `~/.agents/skills` is a symlink here, so the
dormant harnesses see the same set. Every skill is model-invocable except
`reflect`, `correct`, `bro`, `wayfinder`, `install-anti-slop` and
`setup-issue-tracker`, which only Joel starts.

- Entry: `playbooks`. An agent starting non-trivial engineering work matches the
  task to a playbook in `skills/playbooks/` and follows its steps.
- Rules: `principles`, an index plus one file per named principle; TypeScript
  rules live in `coding-standards`. Each rule has one home and every other
  file links to it.
- Workflow skills, the operations playbooks call: `how`, `recall`, `architect`,
  `codebase-design`, `tdd`, `diagnosing-bugs`, `swarm`, `benchmark-checklist`,
  `figure-it-out`, `show-me-your-work`, `reflect`, `correct`, `bro`, `to-tickets`, `wayfinder`,
  `create-verification-skill`, `maintain-verification-skill`, `domain-modeling`,
  `grilling`, `commit`, and the domain skills (
  `workflow-authoring`, `herdr`, `self-modify`, `design-page`, `show-me`,
  `write-discoverable-code`, `writing-for-agents`,
  `setup-issue-tracker`).
- Reviewers, agents that did not write the work: `code-review`, `no-comments`,
  the verdict lanes in `swarm`, and the cross-model review in
  `show-me-your-work`.
- Guardrails: the kit's skills test (`npm test -- skills`) checks names,
  descriptions (200 chars or fewer), relative links, named skills and
  forbidden strings; `install-anti-slop` puts the mechanical rules into a
  repo's linter.

---

## History: two of these used to be patches

`~/.pi/patches` held a patcher that rewrote the installed `dist/` after every
upgrade, kept alive by a shim on `PATH`. It is gone. Six of its seven operations
were rebuilding the footer, which `ctx.ui.setFooter` and
`ctx.ui.setEditorComponent` do properly, and the seventh only emptied
`builtInExtensions` to remove `/llama`, which turned out not to be worth a
patcher.

Two things genuinely cannot be done through the API.

**Built-in slash commands cannot be unregistered.** Each is dispatched by a
hardcoded name check that runs before extension commands.

**User and assistant messages have no render hook.**
`registerMarkdownTransformer` is the only seam, and it hands the text back to
pi's Markdown renderer, which rewraps and restyles it, so a border drawn there
drifts out of true the moment a message contains `**bold**`.
`extensions/zen-chrome/user-message.ts` therefore wraps `render` on the exported
`UserMessageComponent`, and `extensions/quiet-thinking.ts` wraps `updateContent`
on `AssistantMessageComponent`, at session start, and both put them back on
`session_shutdown` (`lib/ui/prototype-patch.ts`). Neither reads anything
private: each hands the original a narrower input and uses what comes back, and
every failure path returns the untouched original.
