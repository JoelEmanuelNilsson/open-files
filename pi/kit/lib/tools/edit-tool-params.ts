import { Type } from "typebox";
import { prepareEditArguments } from "./edit-legacy-arguments.ts";

const editSchema = Type.Object({
	oldText: Type.String({ description: "Exact text to find. Must match the file byte for byte." }),
	newText: Type.Optional(Type.String({ description: "Replacement text. Omit it to delete the matched text." })),
	replaceAll: Type.Optional(
		Type.Boolean({ description: "Replace every occurrence. Without it, oldText must be unique." }),
	),
});

const fileSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)." }),
	edits: Type.Array(editSchema, { description: "Replacements applied to this file." }),
});

export const editToolParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to edit (relative or absolute)." })),
	edits: Type.Optional(
		Type.Array(editSchema, {
			description: "Replacements applied to `path`. Each oldText is matched against the original file.",
		}),
	),
	files: Type.Optional(
		Type.Array(fileSchema, {
			description: "Edit several files in one call. Use instead of path+edits, not alongside them.",
		}),
	),
});

/** Every file an edit call would change, after the tool's own argument preparation: `path`, `file_path` and each `files[].path`. */
export function editTargetPaths(input: Record<string, unknown> | undefined): string[] {
	// SAFETY: prepareEditArguments returns an object or the raw input, which is Record|undefined by signature
	const prepared = prepareEditArguments(editToolParams, input) as Record<string, unknown> | undefined;
	const files = Array.isArray(prepared?.files) ? prepared.files : [];
	// SAFETY: each files entry is untrusted; only .path is read through optional chaining and filtered to strings
	return [prepared?.path, prepared?.file_path, ...files.map((file) => (file as { path?: unknown } | null)?.path)].filter((value): value is string => typeof value === "string");
}
