/**
 * Applying `/skills` decisions to real files, `skill-file-apply.ts`: each file
 * re-read and patched at apply time, written atomically through symlinks, one
 * bad file a failure in the report rather than the end of the batch.
 */

import { eq, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const { applyChanges } = await jiti.import(`${KIT_ROOT}/extensions/skills/skill-file-apply.ts`);
const { setMuted } = await jiti.import(`${KIT_ROOT}/extensions/skills/skill-frontmatter-patch.ts`);

const { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");

const PLAIN = "---\nname: commit\ndescription: Make a commit\n---\n\nBody text.\n";
const MUTED = "---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\n\nBody.\n";

// --- apply: real files, real writes ----------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "pi-kit-skills-"));
const writeSkillInto = (name, file, source, mode = 0o644) => {
	const dir = join(sandbox, name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, source, { encoding: "utf8", mode });
	chmodSync(path, mode);
	return path;
};
const writeSkill = (name, source, mode = 0o644) => writeSkillInto(name, "SKILL.md", source, mode);
const change = (name, path, muted) => ({ name, filePath: path, muted });

try {
	const onePath = writeSkill("one", PLAIN, 0o640);
	const twoPath = writeSkill("two", MUTED);

	eq("a mixed batch writes both files",
		applyChanges([change("one", onePath, true), change("two", twoPath, false)]),
		{ written: 2, failures: [] });
	eq("the muted file gained the key", readFileSync(onePath, "utf8"), setMuted(PLAIN, true));
	eq("the unmuted file lost the key", readFileSync(twoPath, "utf8"), setMuted(MUTED, false));
	eq("the original mode survives the rename", statSync(onePath).mode & 0o777, 0o640);

	// The case the re-read-at-apply-time design exists for: an edit made in
	// another window while the dialog was open must survive the write.
	writeFileSync(onePath, "---\nname: commit\ndescription: Edited elsewhere\ndisable-model-invocation: true\n---\n\nNew body.\n");
	eq("a concurrent edit survives, only the one line is touched",
		[applyChanges([change("one", onePath, false)]), readFileSync(onePath, "utf8")],
		[{ written: 1, failures: [] }, "---\nname: commit\ndescription: Edited elsewhere\n---\n\nNew body.\n"]);

	const prosePath = writeSkill("prose", "# No frontmatter here\n");
	eq("a file with no frontmatter is skipped, not damaged",
		[applyChanges([change("prose", prosePath, true)]), readFileSync(prosePath, "utf8")],
		[{ written: 0, failures: [] }, "# No frontmatter here\n"]);

	// This harness reaches its own skills through ~/.agents/skills, a symlink
	// into the dotfiles checkout, so pi reports every path through that link.
	// Both shapes must survive: a linked directory, and a linked file.
	const realDir = join(sandbox, "real-store");
	mkdirSync(join(realDir, "linked"), { recursive: true });
	const realFile = join(realDir, "linked", "SKILL.md");
	writeFileSync(realFile, PLAIN, "utf8");
	mkdirSync(join(sandbox, "via-file"), { recursive: true });
	const fileLink = join(sandbox, "via-file", "SKILL.md");
	symlinkSync(realFile, fileLink);
	// Reported rather than thrown: without the realpath resolve the rename
	// swaps the link for a regular file, and readlink on a regular file throws
	// EINVAL. A crash here would still fail the run, but it would not say why.
	const linkTargetOf = (path) => {
		try {
			return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : "not a symlink any more";
		} catch (error) {
			return `unreadable: ${error.code}`;
		}
	};
	eq("a symlinked file is followed, not replaced",
		[
			applyChanges([change("linked", fileLink, true)]),
			linkTargetOf(fileLink),
			readFileSync(realFile, "utf8"),
		],
		[{ written: 1, failures: [] }, realFile, setMuted(PLAIN, true)]);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

await finish();
