/**
 * Does every skill under skills/ load, say when to use it, and point only at
 * files and skills that exist? Frontmatter is parsed by pi's own parser, the
 * one that loads skills, so a skill that passes here loads in pi.
 *
 *   node test/kit/skills.test.mjs
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

const { parseFrontmatter } = await importPi("dist/utils/frontmatter.js");

const SKILLS_ROOT = path.join(KIT_ROOT, "skills");
/** Cursor-era names the pi skills must not carry (DESIGN.md, "Pi harness facts"). */
const FORBIDDEN_STRINGS = [".cursor", "subagent_type", "pstack-models", "/loop", "control-ui", "control-cli", "deslop", "create-skill", "grok-", "gpt-5", "claude-opus-5", "Task tool", "poteto", "bugbot"];
/** Skills the kit's prose names that live outside the kit, such as repo-local ones (test-audit, verify-<app>). */
const EXTERNAL_SKILLS = new Set();
/** The system prompt's skills catalogue shows only this many characters of each description. */
const MAX_DESCRIPTION_CHARS = 200;
/** Prose forms that name a skill; bare `the X skill` only for hyphenated X, since "the verify skill" is generic prose. */
const SKILL_REFERENCE_PATTERNS = [
	/\bthe `([a-z0-9-]+)` skill\b/g,
	/\bthe ([a-z0-9]+-[a-z0-9-]+) skill\b/g,
	/`([a-z0-9-]+)` skill\b/g,
	/\/skill:([a-z0-9-]+)/g,
	/\.\.\/([a-z0-9-]+)\/SKILL\.md/g,
];

const skillNames = fs
	.readdirSync(SKILLS_ROOT, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();
const markdownFiles = fs
	.readdirSync(SKILLS_ROOT, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
	.map((entry) => path.join(entry.parentPath, entry.name));
const relative = (file) => path.relative(KIT_ROOT, file);
const withoutFences = (text) => text.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "");
const withoutCode = (text) => withoutFences(text).replace(/(`+)[^`]*?\1/g, "");

section("frontmatter and triggers");
for (const name of skillNames) {
	const file = path.join(SKILLS_ROOT, name, "SKILL.md");
	if (!check(`${name}: has SKILL.md`, fs.existsSync(file), `${relative(file)} is missing`)) continue;
	let frontmatter;
	try {
		frontmatter = parseFrontmatter(fs.readFileSync(file, "utf8")).frontmatter;
	} catch (error) {
		check(`${name}: frontmatter parses`, false, `${relative(file)}: ${error.message}`);
		continue;
	}
	check(`${name}: name matches its directory`, frontmatter.name === name, `${relative(file)}: name is ${JSON.stringify(frontmatter.name)}`);
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	check(`${name}: description is non-empty`, description !== "", `${relative(file)}: description is empty or not a string`);
	check(`${name}: description fits the catalogue cut`, description.length <= MAX_DESCRIPTION_CHARS, `${relative(file)}: description is ${description.length} chars, the catalogue keeps ${MAX_DESCRIPTION_CHARS}`);
	const manual = frontmatter["disable-model-invocation"] === true;
	if (!manual) {
		check(`${name}: description states its trigger`, /\buse\s|\bread before\b/i.test(description), `${relative(file)}: a model-invocable description needs "Use ..." or "read before ...": ${description}`);
	}
}

section("relative links, skill references and forbidden strings");
for (const file of markdownFiles) {
	const text = fs.readFileSync(file, "utf8");
	const prose = withoutCode(text);
	const targets = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map((match) => match[1]);
	const broken = targets.filter((target) => {
		if (/^(https?:|mailto:|#)/.test(target)) return false;
		const local = decodeURIComponent(target.split("#")[0]);
		return !fs.existsSync(path.resolve(path.dirname(file), local));
	});
	check(`${relative(file)}: relative links resolve`, broken.length === 0, `${relative(file)}: broken ${broken.join(", ")}`);

	const referenced = new Set(SKILL_REFERENCE_PATTERNS.flatMap((pattern) => [...withoutFences(text).matchAll(pattern)].map((match) => match[1])));
	const unknown = [...referenced].filter((name) => !skillNames.includes(name) && !EXTERNAL_SKILLS.has(name));
	check(`${relative(file)}: named skills exist`, unknown.length === 0, `${relative(file)}: no skill ${unknown.join(", ")}`);
}
const forbidden = fs
	.readdirSync(SKILLS_ROOT, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.flatMap((entry) => {
		const file = path.join(entry.parentPath, entry.name);
		const text = fs.readFileSync(file, "utf8");
		const found = FORBIDDEN_STRINGS.filter((needle) => text.includes(needle));
		return found.length > 0 ? [`${relative(file)}: contains ${found.join(", ")}`] : [];
	});
check("skills/: no file carries a forbidden string", forbidden.length === 0, forbidden.join("\n       "));

await finish();
