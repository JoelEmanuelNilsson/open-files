import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { transcriptPlannerState } from "./rollup-planner-state.ts";

/** Replace the known skills with these `name → SKILL.md path` pairs. */
export function setKnownSkills(skills: Iterable<[string, string]>): void {
	const known = transcriptPlannerState().skillPaths;
	known.clear();
	for (const [name, path] of skills) {
		try {
			known.set(realpathSync(path), name);
		} catch {}
	}
}

function skillNamed(path: string, cwd: string): string | undefined {
	const absolute = path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
	if (basename(absolute) !== "SKILL.md") return undefined;
	try {
		return transcriptPlannerState().skillPaths.get(realpathSync(absolute));
	} catch {
		return undefined;
	}
}

const UNSAFE = /[|&;<>()$`\\*?[\]{}!#\n]/;

function words(command: string): string[] | undefined {
	const out: string[] = [];
	let current: string | undefined;
	let quote: string | undefined;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = undefined;
			else if (quote === '"' && (char === "$" || char === "`" || char === "\\")) return undefined;
			else current += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			current ??= "";
		} else if (/\s/.test(char) && char !== "\n") {
			if (current !== undefined) out.push(current);
			current = undefined;
		} else if (UNSAFE.test(char)) {
			return undefined;
		} else {
			current = (current ?? "") + char;
		}
	}
	if (quote) return undefined;
	if (current !== undefined) out.push(current);
	return out;
}

function windowRead(program: string, rest: string[]): { window: string; file: string } | undefined {
	if (rest.length === 0) return undefined;
	const file = rest[rest.length - 1];
	const flags = rest.slice(0, -1).join(" ");
	if (program === "sed") {
		const match = /^-n (\d+),(\d+)p$/.exec(flags);
		return match ? { window: `${match[1]}-${match[2]}`, file } : undefined;
	}
	const count = /^(?:-n ?|-)(\d+)$/.exec(flags);
	if (!count) return undefined;
	return { window: program === "head" ? `1-${count[1]}` : `last ${count[1]}`, file };
}

function bashRead(command: string, cwd: string): string | undefined {
	let where = cwd;
	let body = command;
	if (/^\s*cd\s/.test(command) && command.includes("&&")) {
		const cut = command.indexOf("&&");
		const cd = words(command.slice(0, cut));
		if (cd?.length !== 2 || cd[0] !== "cd") return undefined;
		where = resolve(cwd, cd[1] === "~" || cd[1].startsWith("~/") ? resolve(homedir(), cd[1].slice(2)) : cd[1]);
		body = command.slice(cut + 2);
	}
	const [program, ...rest] = words(body) ?? [];
	if (program === "cat") {
		if (rest.length === 0) return undefined;
		const names = rest.map((file) => skillNamed(file, where));
		return names.every((name) => name !== undefined) ? names.join(", ") : undefined;
	}
	if (program !== "head" && program !== "tail" && program !== "sed") return undefined;
	const read = windowRead(program, rest);
	const name = read && skillNamed(read.file, where);
	return read && name ? `${name} ${read.window}` : undefined;
}

/** `commit`, `commit 1-60` or `commit, grilling` when the call only reads known skill files; otherwise undefined. */
export function skillReadLabel(tool: string, args: Record<string, unknown>, cwd: string): string | undefined {
	if (tool === "read") {
		if (typeof args.path !== "string") return undefined;
		const name = skillNamed(args.path, cwd);
		if (!name) return undefined;
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		if (offset === undefined && limit === undefined) return name;
		const from = offset ?? 1;
		return `${name} ${limit === undefined ? `from ${from}` : `${from}-${from + limit - 1}`}`;
	}
	if (tool === "bash" && typeof args.command === "string") return bashRead(args.command, cwd);
	return undefined;
}
