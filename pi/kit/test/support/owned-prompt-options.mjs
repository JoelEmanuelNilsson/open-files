/**
 * The owned-prompt options fixture: a temp dir holding an AGENTS.md and a
 * symlink to it, and pi's `BuildSystemPromptOptions` over them with every
 * input the owned builder maps. A test file builds it once, e.g.
 * `const { dir, options } = ownedPromptOptions();`, and removes `dir` at the end.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The appended system prompt the fixture carries. */
export const APPEND = "<COMMUNICATION>\nsay less\n</COMMUNICATION>";

/** Creates the fixture dir and returns it with the options built over it. */
export function ownedPromptOptions() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-owned-"));
	const agentsPath = path.join(dir, "AGENTS.md");
	fs.writeFileSync(agentsPath, "Solve the system, not the result.");
	const linkPath = path.join(dir, "linked-AGENTS.md");
	fs.symlinkSync(agentsPath, linkPath);

	const options = {
		cwd: dir,
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read file contents", bash: "Execute bash commands" },
		// A tool's own rules and an extension's own section, the two inputs pi 0.86
		// added: material the owned builder must carry rather than quietly drop.
		toolGuidelines: { edit: ["Read a file before editing it"], grep: ["A rule for a tool this seat does not carry"] },
		sections: { handoff: "Hand off with a document." },
		promptGuidelines: ["Trust but verify subagent results"],
		appendSystemPrompt: APPEND,
		contextFiles: [{ path: agentsPath, content: "Solve the system, not the result." }],
		skills: [
			{
				name: "tdd",
				description: "Red-green-refactor",
				filePath: path.join(dir, "tdd/SKILL.md"),
				baseDir: dir,
				sourceInfo: { type: "user" },
				disableModelInvocation: false,
			},
			// Muted with /skills: pi's formatter drops it, so the parity transform
			// in owned-prompt.test.mjs only balances if the owned formatter drops it too.
			{
				name: "herdr",
				description: "Control the terminal multiplexer",
				filePath: path.join(dir, "herdr/SKILL.md"),
				baseDir: dir,
				sourceInfo: { type: "user" },
				disableModelInvocation: true,
			},
		],
	};
	return { dir, agentsPath, linkPath, options };
}
