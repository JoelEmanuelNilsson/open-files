const MAX_SUBSTITUTION_DEPTH = 8;

const WORD_TERMINATORS = new Set(["|", "&", ";", "\n", "(", ")", "<", ">"]);

interface Word {
	text: string;
	quoted: boolean;
	nested: string[];
}

export function commandSegments(command: string): string[][] {
	const segments: string[][] = [];
	collect(command, segments, [], 0);
	return segments;
}

/** The words that follow redirection operators (`> file`, `< file`), which `commandSegments` leaves out. */
export function redirectTargets(command: string): string[] {
	const targets: string[] = [];
	collect(command, [], targets, 0);
	return targets;
}

function collect(command: string, out: string[][], redirects: string[], depth: number): void {
	if (depth > MAX_SUBSTITUTION_DEPTH) return;
	let words: Word[] = [];
	const flush = (): void => {
		const text = words.filter((word) => word.quoted || word.text.length > 0).map((word) => word.text);
		if (text.length > 0) out.push(text);
		for (const word of words) for (const nested of word.nested) collect(nested, out, redirects, depth + 1);
		words = [];
	};

	const pendingHeredocs: string[] = [];
	let index = 0;
	let lastWordEnd = -1;
	while (index < command.length) {
		const char = command[index];

		if (char === "\n") {
			flush();
			index = skipHeredocBodies(command, index + 1, pendingHeredocs);
			continue;
		}
		if (char === " " || char === "\t") {
			index++;
			continue;
		}
		if (char === "#" && atWordStart(command, index)) {
			const lineEnd = command.indexOf("\n", index);
			index = lineEnd === -1 ? command.length : lineEnd;
			continue;
		}
		if (char === "|" || char === "&" || char === ";") {
			flush();
			while (index < command.length && (command[index] === "|" || command[index] === "&" || command[index] === ";")) index++;
			continue;
		}
		if (char === "<" || char === ">") {
			if (index === lastWordEnd && words.length > 0 && /^\d+$/.test(words[words.length - 1].text)) words.pop();
			const heredoc = readHeredocTag(command, index);
			if (heredoc !== undefined) {
				pendingHeredocs.push(heredoc.tag);
				index = heredoc.end;
				continue;
			}
			index = skipRedirectionTarget(command, index, redirects);
			continue;
		}
		if (char === "(" || char === ")" || char === "{" || char === "}") {
			flush();
			index++;
			continue;
		}
		const read = readWord(command, index);
		if (read.end === index) {
			index++;
			continue;
		}
		words.push(read.word);
		index = read.end;
		lastWordEnd = index;
	}
	flush();
}

const atWordStart = (command: string, index: number): boolean => index === 0 || /[\s;&|(]/.test(command[index - 1]);

function readWord(command: string, start: number): { word: Word; end: number } {
	let text = "";
	let quoted = false;
	const nested: string[] = [];
	let index = start;
	while (index < command.length) {
		const char = command[index];
		if (char === "'" || char === '"') quoted = true;
		if (char === " " || char === "\t" || WORD_TERMINATORS.has(char)) break;
		if (char === "\\") {
			if (command[index + 1] === "\n") index += 2;
			else if (index + 1 < command.length) {
				text += command[index + 1];
				index += 2;
			} else index++;
			continue;
		}
		if (char === "'") {
			const close = command.indexOf("'", index + 1);
			if (close === -1) {
				text += command.slice(index + 1);
				return { word: { text, quoted, nested }, end: command.length };
			}
			text += command.slice(index + 1, close);
			index = close + 1;
			continue;
		}
		if (char === '"') {
			const read = readDoubleQuoted(command, index + 1, nested);
			text += read.text;
			index = read.end;
			continue;
		}
		const substitution = readSubstitution(command, index, nested);
		if (substitution !== undefined) {
			text += command.slice(index, substitution);
			index = substitution;
			continue;
		}
		text += char;
		index++;
	}
	return { word: { text, quoted, nested }, end: index };
}

function readDoubleQuoted(command: string, start: number, nested: string[]): { text: string; end: number } {
	let text = "";
	let index = start;
	while (index < command.length) {
		const char = command[index];
		if (char === '"') return { text, end: index + 1 };
		if (char === "\\" && index + 1 < command.length) {
			text += command[index + 1];
			index += 2;
			continue;
		}
		const substitution = readSubstitution(command, index, nested);
		if (substitution !== undefined) {
			text += command.slice(index, substitution);
			index = substitution;
			continue;
		}
		text += char;
		index++;
	}
	return { text, end: index };
}

function readSubstitution(command: string, index: number, nested: string[]): number | undefined {
	if (command[index] === "`") {
		const close = command.indexOf("`", index + 1);
		nested.push(command.slice(index + 1, close === -1 ? command.length : close));
		return close === -1 ? command.length : close + 1;
	}
	if (command[index] !== "$" || command[index + 1] !== "(") return undefined;
	if (command[index + 2] === "(") return skipBalanced(command, index + 2);
	const read = readBalanced(command, index + 2);
	nested.push(read.text);
	return read.end;
}

function readBalanced(command: string, start: number): { text: string; end: number } {
	const end = skipBalanced(command, start);
	const close = end <= command.length && command[end - 1] === ")" ? end - 1 : command.length;
	return { text: command.slice(start, close), end };
}

function skipBalanced(command: string, start: number): number {
	let depth = 1;
	let index = start;
	while (index < command.length) {
		const char = command[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, index + 1);
			index = close === -1 ? command.length : close + 1;
			continue;
		}
		if (char === "(") depth++;
		if (char === ")" && --depth === 0) return index + 1;
		index++;
	}
	return command.length;
}

function readHeredocTag(command: string, index: number): { tag: string; end: number } | undefined {
	const match = /^<<(?!<)-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(index));
	if (match === null) return undefined;
	return { tag: match[1] ?? match[2] ?? match[3], end: index + match[0].length };
}

function skipHeredocBodies(command: string, start: number, pending: string[]): number {
	let index = start;
	while (pending.length > 0) {
		// SAFETY: the loop condition guarantees pending is non-empty
		const tag = pending.shift() as string;
		while (index < command.length) {
			const lineEnd = command.indexOf("\n", index);
			const line = command.slice(index, lineEnd === -1 ? command.length : lineEnd);
			index = lineEnd === -1 ? command.length : lineEnd + 1;
			if (line.trim() === tag) break;
		}
	}
	return index;
}

function skipRedirectionTarget(command: string, start: number, redirects: string[]): number {
	let index = start;
	while (index < command.length && (command[index] === "<" || command[index] === ">" || command[index] === "&")) index++;
	while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
	const read = readWord(command, index);
	if (read.end === index) return index;
	redirects.push(read.word.text);
	return read.end;
}

const WRAPPERS: Record<string, readonly string[]> = {
	sudo: ["-u", "-g", "-C", "-D", "-p", "-r", "-t", "-T", "-U"],
	time: ["-o", "-f"],
	env: ["-u", "-C", "-P"],
	command: [],
	builtin: [],
	if: [],
	then: [],
	else: [],
	elif: [],
	do: [],
	while: [],
	until: [],
	"!": [],
	xargs: ["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a"],
};

export function* programSegments(command: string): Generator<{ program: string; args: string[]; wrappers: string[] }> {
	for (const tokens of commandSegments(command)) {
		const wrappers: string[] = [];
		let index = 0;
		for (;;) {
			while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
			const wrapper = basename(tokens[index] ?? "");
			const valued = WRAPPERS[wrapper];
			if (valued === undefined) break;
			wrappers.push(wrapper);
			index++;
			while (index < tokens.length && tokens[index].startsWith("-")) {
				const option = tokens[index];
				index += option !== "--" && valued.includes(option) ? 2 : 1;
				if (option === "--") break;
			}
		}
		if (index < tokens.length) yield { program: basename(tokens[index]), args: tokens.slice(index + 1), wrappers };
	}
}

const basename = (token: string): string => token.split("/").pop() ?? "";
