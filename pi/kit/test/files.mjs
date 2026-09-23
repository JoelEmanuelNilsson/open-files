/**
 * The suite, in order.
 *
 * `run.mjs` executes it. The list used to live inside `package.json`'s `test`
 * script, parsed back out by splitting on `&&`; a list that has to be recovered
 * from a shell string is a list with two definitions.
 *
 * The environment the files run in used to live here too, as a `childEnv()`
 * only the runner applied. It is `env.mjs` now, which each file imports for
 * itself — see the header there for why a runner-only environment left six of
 * them writing into the seat's own state directory.
 */
import { testEnv } from "./env.mjs";

export const TEST_FILES = [
	"test/smoke.mjs",
	"test/render.mjs",
	"test/transcript.mjs",
	"test/transcript-two-jitis.mjs",
	"test/click.mjs",
	"test/quiet-thinking.mjs",
	"test/agent-rows.mjs",
	"test/renderers.mjs",
	"test/prose-links.mjs",
	"test/sessions.mjs",
	"test/wire-trace.mjs",
	"test/wire-dump.mjs",
	"test/quota-meter.mjs",
	"test/codex-quota.mjs",
	"test/ping.mjs",
	"test/tool-policy.mjs",
	"test/prompt-render.mjs",
	"test/guards.mjs",
	"test/tool-arguments.mjs",
	"test/notice.mjs",
	"test/chat.mjs",
	"test/bash.mjs",
	"test/context-view.mjs",
	"test/skills.mjs",
	"test/read-memo.mjs",
	"test/continue-session.mjs",
	"test/continue-session-live.mjs",
	"test/side-mode.mjs",
	"test/side-chat.mjs",
	"test/side-screen.mjs",
	"test/wire-side.mjs",
	"test/agent-dock.mjs",
	"test/model-label.mjs",
	"test/model-catalog.mjs",
	"test/chrome-color.mjs",
	"test/chrome-cells.mjs",
	"test/animation-clock.mjs",
	"test/prompt-fold.mjs",
	"test/warm-prefix.mjs",
	"test/agent-box.mjs",
	"test/diff-view.mjs",
	"test/agent-engine.mjs",
	"test/agent-engine-live.mjs",
	"test/agent-doctrine.mjs",
	"test/workflow.mjs",
	"test/workflow-ui.mjs",
	"test/shared-state.mjs",
	"test/comment-lint.mjs",
];

/** The environment for a child of the runner: this process's, which `env.mjs` already made safe. */
export function childEnv() {
	return testEnv(process.env);
}
