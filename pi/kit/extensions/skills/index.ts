/**
 * skills — decide which skills the model may reach for, without opening a file.
 *
 * Every skill is always invocable by hand as `/skill:name`. What this toggles
 * is the other half: whether pi advertises the skill to the model, which is
 * the `disable-model-invocation` line in its frontmatter and about forty
 * tokens of name and description in every single request. Twenty-eight skills
 * is a paragraph of standing context, so "which of these does the model still
 * need to know exist?" is a question worth being able to answer in ten seconds
 * rather than across twenty-eight files.
 *
 * Three facts shape the whole design, and each one deletes code a standalone
 * version of this tool would have to carry:
 *
 *   - **pi already did the discovery.** `getSystemPromptOptions().skills` is
 *     the complete loaded set — every scope, every package, muted ones
 *     included — already parsed, with `filePath` and `disableModelInvocation`
 *     on each. So there is no directory scan and no frontmatter *reader* here:
 *     a second one could only ever disagree with the one that counts.
 *   - **the file is the only state.** Nothing is remembered between runs and
 *     nothing shadows the file at runtime, so the frontmatter and the
 *     behaviour cannot drift apart.
 *   - **`ctx.reload()` exists.** Writes take effect on the next turn without
 *     the user running `/reload`, so applying is one keystroke rather than two
 *     steps with a note in between.
 *
 * This file is wiring only. The dialog's state is `model.ts`, the one line it
 * writes is `patch.ts`, the files it writes are `apply.ts`, and the screen is
 * `view.ts` — each testable without a terminal or a running pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { notice } from "../../lib/notice.ts";
import { applyChanges, describeChanges } from "./apply.ts";
import { buildRows } from "./model.ts";
import { showSkillsView } from "./view.ts";

export default function skills(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Choose which skills the model may invoke",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				notice(ctx, "/skills requires TUI mode.", "warning");
				return;
			}
			const rows = buildRows(ctx.getSystemPromptOptions().skills ?? []);
			if (rows.length === 0) {
				notice(ctx, "No skills are loaded in this session.", "warning");
				return;
			}

			const changes = await showSkillsView(ctx, rows);
			if (changes === undefined || changes.length === 0) return;

			const { written, failures } = applyChanges(changes);
			for (const failure of failures) notice(ctx, `skills: ${failure}`, "error");
			if (written === 0) return;

			notice(ctx, `skills: ${describeChanges(changes, written)}. Reloading.`, "info");
			// Last, and awaited: this replaces the extension runtime, including the
			// instance running this handler.
			await ctx.reload();
		},
	});
}
