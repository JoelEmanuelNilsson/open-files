# Facts — pi transcript vs Claude Code

`derived` = a command or a read of source printed it. `said` = a session's understanding.
Paths: `PI` = `$(npm root -g)/@earendil-works/pi-coding-agent`, `SUB` = `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents`,
`KIT` = `~/dotfiles/pi/kit/extensions`, `CC` = `~/Downloads/CC-src`.

## The instance: two turns of this session, 18:45–18:47, 2026-09-02

derived — screenshots `NSIRD_screencaptureui_o51zBq/…18.47.41.png` (launch rows) and `NSIRD_screencaptureui_SvB0AF/…18.47.13.png` (completion, result blob, widget, dock).
Lines counted by hand off the screenshots. Terminal width 178 columns.

| Block | Lines now | Emitter |
|---|---|---|
| `Thinking...` + spacer | 2 | PI `assistant-message.js:74,109` |
| Two `▸ Agent` launch rows, each 2 lines + 3 blanks | 10 | SUB `index.ts:1707`, PI `tool-execution.js:44,48` |
| `✓ … completed` block: 4 lines + wrapped path 2 lines + 3 blanks | 9 | SUB `index.ts:308-370`, PI `custom-message.js:21` |
| `get_subagent_result` fallback: name + 3 header + 8 preview + footer + 3 blanks | 16 | PI `tool-execution.js:105-125` |
| Above-editor `● Agents` widget | 3 | SUB `ui/agent-widget.ts:628` |
| Below-editor dock: blank + `● main` + 1 agent + `1 running agent` | 4 | SUB `ui/fleet-list.ts:223,460-495` |
| `[skill] design-page` custom message: 3 blanks above, 2 below | 5 extra | PI `custom-message.js:21` Spacer + `skill-invocation-message.js:14` Box(1,1) |

## Registration precedence

derived — `PI/dist/core/extensions/runner.js:324-335` (tools), `:425-433` (message renderers), `:437-444` (entry renderers): `if (!has(name)) set(...)` looping extensions in load order. **First extension wins.**
derived — `runner.js:373-390`: `registerShortcut` is **last** wins. `interactive-mode.js:1720-1752`: `setWidget(key)` last call wins, keys global.
derived — `PI/dist/core/package-manager.js:704-709, 981-983, 2054-2077`: packages load in `settings.json` array order; all packages rank 4, stable sort.
derived — `PI/dist/core/extensions/loader.js:243-248`: `registerTool` inside `session_start` writes into the same map, so position not time decides.
derived — `~/dotfiles/pi/settings.json:7-12`: order is pi-web-search, @tintinweb/pi-subagents@0.19.0, ~/dotfiles/pi/kit, @plannotator/pi-extension. **Kit loses every conflict today.**

## Why bash never folds

derived — `PI/dist/core/extensions/loader.js:417-418`: `createJiti(import.meta.url, { moduleCache: false })` per extension file.
derived — `KIT/bash.ts:92` imports `./transcript/receipt.ts` → `receipt.ts:15` imports `roleOf` from `group.ts`. Second evaluation, second `seats` map (`group.ts:150`).
derived — `group.ts:211`: `roleOf` returns `"row"` when `seats.get(id)` is undefined. Bash rows never ask the real planner.
derived — live repro in herdr pane: three `echo` bash calls + one read → three bash rows drawn, the read row hidden, **no rollup line**. Output lost.
derived — `/tmp/repro-events.mjs`: same events, one shared jiti → `Read 1 file, ran 3 shell commands`; two jitis → three bash rows. `npm test` (231 passed) uses one jiti (`test/transcript.mjs:10`).
derived — `group.ts:232`: `if (group.ids.length === 1) return "row"` — a settled group of one never folds. `HANDOFF.md` says "one call collapses as readily as seven"; code disagrees.
derived — `group.ts:538 speaks()` counts a thinking block as prose; `test/transcript.mjs:606` asserts it. With `hideThinkingBlock: true` and a thinking model, nearly every message is a group of one.
derived — `KIT/transcript/click.ts:96 rowAtLine`: click on the rollup line lands on the speaker; `test/transcript.mjs:899-905`. Works, fullscreen only.

## The thinking stub

derived — `PI/dist/modes/interactive/interactive-mode.js:271` `defaultHiddenThinkingLabel = "Thinking..."`; `:1705` `setHiddenThinkingLabel(label)` → `label ?? default`; `:1793` `resetExtensionUI()` resets it.
derived — `PI/dist/modes/interactive/components/assistant-message.js:72-74`: `hasVisibleContent` counts thinking → `Spacer(1)`; `:109` draws `Text(theme.italic(theme.fg("thinkingText", label)))`.
derived — `PI/dist/modes/interactive/theme/theme.js:273-277`: `theme.fg` wraps even `""` in escapes; `pi-tui/dist/components/text.js:43` trim test never fires. Running it: label `""` → 1 line of escapes + the spacer = **2 blank lines**. Zero lines is impossible from the extension API.
derived — `KIT/transcript/click.ts` already patches a pi internal (`TuiAltScreen.handleViewportInput`) via `Symbol.for("transcript.viewport-input")`. Same pattern applies to `AssistantMessageComponent`.

## Spacing

derived — `PI/dist/modes/interactive/components/tool-execution.js:44` `Spacer(1)`, `:48` `Box(1,1)` → default tool row: 3 blank lines between rows. `:197` `renderShell:"self"` → exactly 1 blank, hardcoded.
derived — `custom-message.js:21` `Spacer(1)` + (default only) `Box(1,1)`.
derived — `KIT/transcript/result.ts:127-133` pushes content lines only; zen-chrome `message.ts:41-47` trims pi's box blanks on user messages. Receipt rows = 1 blank + header + `⎿` = Claude Code's spacing.
derived — CC `CC/utils/collapseReadSearch.ts:762,927-947`: prose flushes a group and is rendered; thinking blocks skipped, do not break the group (`:380`).

## Claude Code shapes

derived — `CC/components/CollapsedReadSearchContent.tsx:420-460`: `Read 3 files, ran 1 shell command`, dim, counts bold, `(ctrl+o to expand)`; no dot once resolved.
derived — `CC/utils/collapseReadSearch.ts:224-238,816`: non-search Bash folds only under `isFullscreenEnvEnabled()`; search-like Bash (`cat`, `ls`, `grep`) always folds.
derived — `CC/components/Messages.tsx:561-596,624`; `messageActions.tsx` `'enter'` action: rollup expands by ctrl+o, mouse click, or select row + Enter.
derived — `CC/utils/terminal.ts:71-113` `MAX_LINES_TO_SHOW = 3`; footer `… +70 lines (ctrl+o to expand)`. Bash header `MAX_COMMAND_DISPLAY_LINES=2`, `MAX_COMMAND_DISPLAY_CHARS=160` (`tools/BashTool/UI.tsx:25-26`).
derived — `CC/tools/FileWriteTool/UI.tsx:26,88`: Write shows 10 lines then `… +N lines`. Edit shows the full diff (`FileEditTool/UI.tsx:139-141`).
derived — `CC/tools/AgentTool/UI.tsx:~735-750`: `● 5 background agents launched (↓ to manage)`; `AgentProgressLine.tsx`: `├─ Type (description) · 3 tool uses · 1.2k tokens`; completion `Done (3 tool uses · 12.4k tokens · 45s)` at `:370-406`.
derived — `pi-subagents/src/ui/fleet-list.ts:469`: the `esc to interrupt · ← for agents · ↓ to manage` row is the fleet dock's own hint; `fleetView: false` removes it. `kit/extensions/zen-chrome/index.ts:1-11`: the kit owns the prompt frame and its bottom rule (`bottomRule`), so a count can be drawn there without a row.

derived — `CC/components/tasks/BackgroundTaskStatus.tsx:220-232`: footer pill `2 tasks · ↓ to view`; nothing when zero tasks (`:187-189`). `PromptInput.tsx:1738-1772`: ↓ selects pill, ↓ again opens `BackgroundTasksDialog` (modal, `BackgroundTasksDialog.tsx:560-651`), ↑ deselects. `x` stops, Esc closes.
derived — `CC/components/messages/AssistantThinkingMessage.tsx:38-56`: `∴ Thinking (ctrl+o to expand)`, one line.

## pi-subagents surfaces

derived — `SUB/src/index.ts:1651,1672,1707` `Agent` renderCall/renderResult; `:2302` registration. `:2732` `get_subagent_result` and `:2821` `steer_subagent` have **no** renderers.
derived — `SUB/src/index.ts:308-370` `subagent-notification` renderer; `:171-199` model text; `:343` preview `.slice(0,80)`; `:344` path appended into one `Text` so wraps to column 0.
derived — `SUB/docs/rpc.md:11-52,104-163`: `subagents:rpc:spawn` and `subagents:rpc:consume`; `consume` must land synchronously in the `subagents:completed` handler (200 ms `NUDGE_HOLD_MS`, `index.ts:451`). Spawn strips 8 fields silently, never validates keys.
derived — `SUB/src/settings.ts:126 fleetView` (default true, `index.ts:1140`), `:165 widgetMode` (default `"background"`), `:176 outputTranscript` (default true), `:279 showCost`, `:291 showModel`.
derived — `SUB/src/agent-runner.ts:847-865`: nested tools only when the agent sets `allowed_subagents`, depth < `maxSubagentDepth` (default 2), and not isolated. `SUB/dist/default-agents.js:9-22`: built-in `general-purpose` sets none.
derived — `~/2` track transcripts (`…/Users-joel-2/01a0629a…/tasks/*.output`): 3 of 5 orchestrators wrote "no Agent tool"; the diagnosis track ran `pi -p …` from bash 33 times. The ledger line "sub-agents can spawn seats after all" is false.
derived — `SUB/src/ui/agent-widget.ts:101-105` `formatTokens` never pluralises: `142.1k token`.

## Small ones

derived — `KIT/todos/index.ts:159` builds `` `${safeKeyText("ctrl+shift+t")} to expand` ``; `keybinding-hints.js:24-26` returns `""` for a raw chord → `└  to expand`.
derived — `KIT/transcript/header.ts:139` clips the header to one line with `…`.
derived — `~/.pi/agent/extensions/herdr-agent-state.ts` is byte-identical to `KIT/herdr-agent-state.ts`; both load.

## Absent

absent — no way to reach a tool's `execute` from another extension (`PI/types.d.ts:1192-1194`); owning a vendor tool's row means re-registering it first and forwarding.
absent — no pi API for a zero-line hidden thinking block.
absent — no CC test for the `(↓ to manage)` panel folding on ↑ inside a list; CC has no inline list.
