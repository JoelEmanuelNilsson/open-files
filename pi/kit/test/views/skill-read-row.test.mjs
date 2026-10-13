/**
 * A model's read of a known SKILL.md draws `● Skill(name)` (lib/transcript/skill-read.ts),
 * through `read` or a bash command that only reads skill files.
 */

import { eq, finish } from "../support/check-harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { answer, assistant, reading, ran, renderContext, sgrTheme, stripAnsi } from "../support/tool-row-fixtures.mjs";

const jiti = kitJiti();
const { toolHeader, receipt } = await jiti.import(`${KIT_ROOT}/lib/transcript/tool-receipt.ts`);
const { setKnownSkills } = await jiti.import(`${KIT_ROOT}/lib/transcript/skill-read.ts`);
const { plan } = await jiti.import(`${KIT_ROOT}/lib/transcript/rollup-plan.ts`);

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-skill-read-")));
const skill = (name) => {
	fs.mkdirSync(path.join(dir, name), { recursive: true });
	const file = path.join(dir, name, "SKILL.md");
	fs.writeFileSync(file, `# ${name}\nbody\n`);
	return file;
};
const commit = skill("commit");
const grilling = skill("grilling");
const stray = skill("upstream");
fs.symlinkSync(path.join(dir, "commit"), path.join(dir, "linked"));
setKnownSkills([["commit", commit], ["grilling", grilling]]);

const row = (tool, args, over = {}) => stripAnsi(toolHeader(tool, args, sgrTheme, renderContext({ cwd: dir, ...over })).render(100)[0]);
const bash = (command) => row("bash", { command });

eq("read of a known SKILL.md is a Skill row", row("read", { path: commit }), "● Skill(commit)");
eq("through a symlinked directory too", row("read", { path: path.join(dir, "linked", "SKILL.md") }), "● Skill(commit)");
eq("a partial read names its lines", row("read", { path: commit, offset: 1, limit: 60 }), "● Skill(commit 1-60)");
eq("a SKILL.md pi does not know keeps the Read row", row("read", { path: stray }), "● Read(upstream/SKILL.md)");
eq("a subagent row keeps the Read row", row("read", { path: commit }, { state: { offTranscript: true } }), "● Read(commit/SKILL.md)");

eq("bash cat of a known skill", bash(`cat ${commit}`), "● Skill(commit)");
eq("cat of two skills", bash(`cat ${commit} ${grilling}`), "● Skill(commit, grilling)");
eq("leading cd, relative path", bash("cd commit && cat SKILL.md"), "● Skill(commit)");
eq("sed window", bash(`sed -n '1,60p' ${commit}`), "● Skill(commit 1-60)");
eq("head window", bash(`head -n 40 ${commit}`), "● Skill(commit 1-40)");
eq("a pipe keeps the Bash row", bash(`cat ${commit} | wc -l`).startsWith("● Bash("), true);
eq("a second command keeps the Bash row", bash(`cat ${commit}; rm x`).startsWith("● Bash("), true);
eq("an unknown file in the cat keeps the Bash row", bash(`cat ${commit} ${stray}`).startsWith("● Bash("), true);
eq("a variable keeps the Bash row", bash("cat $X/SKILL.md"), "● Bash(cat $X/SKILL.md)");

const settled = (tool, args, over = {}) => {
	const context = renderContext({ cwd: dir, args, ...over });
	return receipt(tool).renderResult({ content: [{ type: "text", text: "# commit\nbody\n" }] }, { isPartial: false, expanded: context.expanded }, sgrTheme, context).render(100).map(stripAnsi).filter((line) => line.trim() !== "");
};
eq("collapsed, the result draws nothing", settled("read", { path: commit }), []);
eq("expanded, the result is the file text", settled("read", { path: commit }, { expanded: true }).map((line) => line.trim()).filter((line) => line.endsWith("body")).length, 1);
eq("an error keeps its result row", settled("read", { path: commit }, { isError: true }).length > 0, true);

const grouped = (...calls) => plan([assistant(...calls), ...calls.map((c) => answer(c.id))]).map((g) => g.ids.join("+"));
eq("ordinary reads fold", grouped(reading("a", stray), reading("b", stray)), ["a+b"]);
eq("a skill read keeps its own row", grouped(reading("a", stray), reading("s", commit), reading("b", stray)), ["a", "b"]);
eq("so does a bash cat of one", grouped(ran("c", `cat ${commit}`), reading("b", stray)), ["b"]);

await finish();
