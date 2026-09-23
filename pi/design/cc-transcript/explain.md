# Explain — one entry per term, box and number on the page

Each entry: what it is, why that name, where it lives, how we work on it, what can go wrong.

## receipt
What: the one-or-two-line shape a finished tool call leaves behind: `● Read(path)` then `⎿  Read 42 lines`. The name says it: a receipt for work done, not the work itself.
Where: `~/dotfiles/pi/kit/extensions/transcript/` (~2,900 lines TypeScript: `row.ts`, `header.ts`, `result.ts`, `receipt.ts`).
How we work on it: `npm test` in the kit, `node test/preview-transcript.mjs` to look.
Goes wrong: a tool that never got a receipt falls back to pi's padded box — three blank lines and raw text at column 0. That is most of the ugliness on this page.

## rollup
What: the dim line that replaces several receipts once the turn settles: `Read 1 file, ran 3 shell commands`. Claude Code's word for it is a collapsed read/search group.
Where: `transcript/rollup.ts` (phrase table) and `group.ts` (who folds into whom).
Goes wrong: bash rows never fold today (see planner copy), and a lone call never folds (see lone call).

## planner
What: the piece that decides, for each row, whether it is the speaker of a group, a hidden member, or a plain row. Lives in one map called `seats`.
Where: `transcript/group.ts:150` (`seats`), `:211` (`roleOf`).
Goes wrong: pi loads every extension file with its own module cache, so `bash.ts` gets a second, empty copy of this map. Bash rows ask the empty copy and are told "row". Fix: keep the map on the process (`Symbol.for(...)`), the way `click.ts` already keeps its patch.

## planner copy
What: the second evaluation of `group.ts` that `bash.ts` sees. Same code, different memory.
Where: created by `pi/dist/core/extensions/loader.js:417` (`moduleCache: false`).
So what: this is why `read` folds and `bash` does not. It is also why the tests are green: they load everything through one cache.

## lone call
What: a settled group with one member. `group.ts:232` keeps it as a full row on purpose; Claude Code folds it to `Ran 1 shell command`.
Decision: fold it. The row changes shape once, at settle, which is what Claude Code does too.

## prose rule
What: a message that says anything ends the current group. Claude Code has the same rule and keeps the prose on screen.
Where: `group.ts:57-63` (comment), `:538` (`speaks`).
Goes wrong: a hidden thinking block counts as "saying something". Claude Code skips thinking blocks. Once ours does too, calls on either side of a thought fold together.

## thinking stub
What: the italic `Thinking...` line pi prints for every hidden reasoning block.
Where: `pi/dist/modes/interactive/interactive-mode.js:271` (label), `components/assistant-message.js:74,109` (spacer + line).
Goes wrong: an empty label still draws a line of colour codes, plus a spacer — two blanks. No extension API reaches zero. Fix: patch pi's component at load (the kit already patches one pi internal), and send the change upstream.

## first wins
What: pi's rule for two extensions registering the same tool name or message type: the one that loaded first keeps it. Load order is the `packages` array in `settings.json`.
Where: `pi/dist/core/extensions/runner.js:324-335, 425-433`.
So what: the kit is third in that array, behind pi-subagents, so it cannot own any agent surface until the order flips. Shortcuts are the opposite (last wins), so the flip also changes who sees a key first.

## pi-subagents
What: the vendor package that gives pi the `Agent`, `get_subagent_result`, `steer_subagent` tools, the completion notice, the Agents widget and the fleet dock. Pinned at 0.19.0.
Where: `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/src/`.
How we work on it: never edit it. Settings in `~/dotfiles/pi/subagents.json`; its RPC bus (`docs/rpc.md`) for spawning from our own tool.
Goes wrong: its rows do not wear the receipt, so every one of them costs three blank lines and a different glyph vocabulary.

## launch row
What: what the `Agent` tool draws when it starts a background agent: `▸ Agent  description` and `⎿  Running in background (ID: …)`.
Where: `pi-subagents/src/index.ts:1707`.
Target: Claude Code's `● 2 background agents launched (↓ to manage)` with a `├─` tree of names. Needs the kit to own `Agent` first and forward to the RPC bus.

## completion notice
What: the `✓ description completed` block with stats, a preview line and the transcript path.
Where: `pi-subagents/src/index.ts:308-370`; the model text at `:171-199`.
Target: one receipt line, `Done · 15 tools · 71.9k tokens · 1m14s`. The screen half is a renderer the kit can own once the order flips. The model half cannot be edited, only replaced: consume the vendor's notice and send our own.

## result blob
What: the `get_subagent_result` output printed raw — bold name, header fields, markdown source, `… (71 more lines)`.
Where: no renderer at all in pi-subagents (`index.ts:2732`), so pi's fallback draws it (`tool-execution.js:105-125`).
Target: agents write their report to a file, the orchestrator reads it: `Read 1 file`. The transcript already knows that shape. No renderer to fight.

## Agents widget
What: the `● Agents └ Agent (twin) … ↻14 · 23 tool uses · 89.1k token (9%) · 109.7s` block above the editor while a background agent runs. It goes away when the last agent finishes, which reads as "sometimes it stays".
Where: `pi-subagents/src/ui/agent-widget.ts:628`; setting `widgetMode` (`"background"` today).
Fix: `widgetMode: "off"`.

## fleet dock
What: the permanent list below the editor: `● main`, one row per agent, `1 running agent`.
Where: `pi-subagents/src/ui/fleet-list.ts:223`; setting `fleetView`.
Fix: `fleetView: false`, then the kit draws Claude Code's shape.

## footer pill
What: Claude Code's whole idle-state agent UI: one dim item in the prompt footer, `2 tasks · ↓ to view`. Nothing when there are no tasks.
Ours: the same count, `1 task ↓`, drawn inside the bottom rule of the prompt frame beside the branch and context bar. `zen-chrome` owns that rule (`kit/extensions/zen-chrome/chrome.ts`, `bottomRule`), so it costs no row. The `esc to interrupt · ← for agents · ↓ to manage` row is the fleet dock's hint (`pi-subagents/src/ui/fleet-list.ts:469`) and goes with `fleetView: false`.
Where: `CC/components/tasks/BackgroundTaskStatus.tsx:220-232`.
Keys: ↓ selects it, ↓ again or Enter opens the modal, ↑ deselects. That deselect is the "fold away" feel.

## tasks modal
What: Claude Code's `Background tasks` dialog over the whole screen: rows per agent with elapsed and tokens, `↑/↓ select · Enter view · x stop · Esc close`.
Where: `CC/components/tasks/BackgroundTasksDialog.tsx:560-651`.
So what: the multi-row list exists only here. There is no inline list to fold.

## transcript path
What: the `/var/folders/…/tasks/9cc0afca-4f6a-475.output` line in the completion notice, 120 characters, wrapped to column 0.
Where: `pi-subagents/src/index.ts:344`; setting `outputTranscript`.
Fix: `outputTranscript: false` removes it from the screen and from the model text.

## skill line
What: the `[skill] design-page (ctrl+o to expand)` message after a `$skill` mention.
Where: `kit/extensions/skill-mentions.ts:186` returns pi's own boxed component (`skill-invocation-message.js:14`, padding 1/1) under pi's spacer.
Fix: return a one-line component of our own. Kit only.

## blank lines
What: pi's spacing rules. A tool row in the default shell: spacer + box padding = three blanks between rows. A receipt (`renderShell: "self"`): exactly one blank, hardcoded. A custom message: one spacer, plus box padding if the renderer reuses pi's box.
Where: `tool-execution.js:44,48,197`; `custom-message.js:21`.
So what: every extra blank on this page is a row that did not get the receipt shell.

## nested agents
What: whether a subagent gets its own `Agent` tool. Off unless the agent's definition sets `allowed_subagents`; never when isolated in a worktree; capped at depth 2.
Where: `pi-subagents/src/agent-runner.ts:847-865`; built-in `general-purpose` sets none.
Fix: `~/dotfiles/pi/agents/general-purpose.md` with `allowed_subagents: all`. Also correct the `~/2` ledger line that says seats can spawn.

## head preview
What: Claude Code's result shape: the first three lines, then `… +70 lines (ctrl+o to expand)`.
Ours: the last line, one line, `+N lines`, no hint.
Where: `CC/utils/terminal.ts:71-113`; ours `transcript/result.ts:138-168`.
Decision: which one.

## two-line header
What: Claude Code lets a bash header run two lines, 160 characters, before `…`. Ours clips at one line.
Where: `CC/tools/BashTool/UI.tsx:25-26`; ours `transcript/header.ts:139`.
Decision: bounded relaxation to two lines, or stay.

## plan hint
What: the `└  to expand` line under a plan with no key in it.
Where: `kit/extensions/todos/index.ts:159` asks the keybinding registry for a raw chord; it returns nothing.
Fix: format the same value that was passed to `registerShortcut`.

## RPC bus
What: pi-subagents' documented way for another extension to spawn, consume or inspect agents without owning its code: `subagents:rpc:spawn`, `subagents:rpc:consume`, the registry at `Symbol.for("pi-subagents:manager")`.
Where: `pi-subagents/docs/rpc.md`.
Goes wrong: `spawn` drops eight option fields silently and never validates keys; `consume` must land within 200 ms of completion or the vendor's notice fires anyway.

## pi patch
What: replacing one method on a pi class at load time, from the kit, keyed by a `Symbol.for` so two copies of the kit file patch once.
Where: precedent `transcript/click.ts` on `TuiAltScreen.handleViewportInput`.
Goes wrong: a pi upgrade renames the method. A kit test that imports the installed pi and asserts the method exists turns that into a red test, not a silent regression.
