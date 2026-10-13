import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { notice } from "../../lib/process/human-notice.ts";
import { applyChanges, describeChanges } from "./skill-file-apply.ts";
import { buildSkillRows } from "./skill-draft.ts";
import { showSkillsView } from "./skills-view.ts";

export default function skills(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "Choose which skills the model may invoke",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				notice(ctx, "/skills requires TUI mode.", "warning");
				return;
			}
			const rows = buildSkillRows(ctx.getSystemPromptOptions().skills ?? []);
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
			await ctx.reload();
		},
	});
}
