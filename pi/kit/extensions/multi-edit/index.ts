import {
	type EditToolDetails,
	type ExtensionAPI,
	generateDiffString,
	generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { registerAbortBoundedTool } from "../../lib/tools/tool-abort-bound.ts";
import { commitFileEdits, type FileEdits, planFileEdits } from "./edit-file-plan.ts";
import { prepareEditArguments } from "../../lib/tools/edit-legacy-arguments.ts";
import { editToolParams } from "../../lib/tools/edit-tool-params.ts";
import { renderEditCall, renderEditResult } from "./edit-tool-rows.ts";

export default function (pi: ExtensionAPI) {
	registerAbortBoundedTool(pi, {
		name: "edit",
		label: "Edit",
		description:
			`Edit files by exact text replacement. Two forms, never both in one call: \`path\` + \`edits[]\` for one file, or \`files[]\` for several files. All replacements are dry run first: if any of them fails, nothing is written. Each oldText must be unique in the file unless you set replaceAll. The file must exist.`,
		promptGuidelines: [
			"When changing several places in one file, use one edit call with multiple entries in edits[]",
			"When changing several files at once, use one edit call with files[{path, edits}] instead of one call per file",
			"Keep edits[].oldText minimal but unique. If edit reports N matches, add surrounding context rather than retrying the same text.",
		],
		parameters: editToolParams,

		prepareArguments: (args) => prepareEditArguments(editToolParams, args),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, edits, files } = params;
			if (edits?.length && files?.length) {
				throw new Error("Use `path` + `edits[]` or `files[]`, not both.");
			}

			const targets: FileEdits[] = [];
			if (edits?.length) {
				if (!path) throw new Error("`edits` needs a `path`. Use `files[]` for multiple files.");
				targets.push({ path, edits });
			}
			for (const file of files ?? []) {
				targets.push({ path: file.path ?? path ?? "", edits: file.edits });
			}
			if (targets.length === 0) {
				throw new Error("Nothing to do: provide path+edits or files[].");
			}
			const changes = await planFileEdits(ctx.cwd, targets);

			if (signal?.aborted) throw new Error("Aborted before writing.");

			const written = await commitFileEdits(changes);

			const multiFile = changes.length > 1;
			const diff = changes
				.map((change) => {
					const body = generateDiffString(change.before, change.after).diff;
					return multiFile ? `File: ${change.path}\n${body}` : body;
				})
				.join("\n\n");
			const unified = changes
				.map((change) => generateUnifiedPatch(change.path, change.before, change.after))
				.join("\n");
			const firstChangedLine = generateDiffString(changes[0].before, changes[0].after).firstChangedLine;

			const summary = changes.map((change) => `Edited ${change.path}`).join("\n");

			const details: EditToolDetails = { diff, patch: unified, firstChangedLine };
			return {
				content: [{ type: "text", text: `${summary}\n(${written.length} file(s) written)` }],
				details,
			};
		},

		renderShell: "self",

		renderCall: renderEditCall,
		renderResult: renderEditResult,
	}, () => "Edits it had begun writing still finish writing; read the files to see which changed.");
}
