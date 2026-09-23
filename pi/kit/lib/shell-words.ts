/**
 * A bash command line read as the simple commands it actually runs.
 *
 * Why this exists: the scan guard (`lib/tool-policy.ts`) judges a command by
 * its first literal token, so it has to know which characters are shell syntax
 * and which are data. It used to ask with a regex —
 * `command.split(/\|\||&&|[;|\n]/)` — which cannot tell the difference. A pipe
 * inside a quoted string became a fake command, and the refusal then named a
 * program the user never ran. That fired three times on 2026-09-02/03: once on
 * an `echo` whose argument mentioned `grep -r|find /`, once inside a `node -e`
 * string literal, and once on a heredoc whose *body* merely talked about
 * finding something. The same blindness ran the other way too — `ls $(find /
 * -name x)` walked straight past the guard, because nothing ever looked inside
 * the substitution.
 *
 * Both are the same bug: guessing at structure instead of reading it. So this
 * is a lexer. It tracks single and double quotes, backslash escapes, line
 * continuations, comments and heredoc bodies, and it recurses into `$( )` and
 * backticks, which are commands and must be judged as commands.
 *
 * What it deliberately is not: a shell. No expansion is performed — `$x` stays
 * `$x`, because the guard matches literal roots and a value it cannot know is a
 * value it must not invent. Control keywords (`if`, `for`, `while`) are
 * ordinary words; the guard only ever asks what a segment's first word is, and
 * a scanner behind a keyword still arrives as its own segment after the `;`.
 *
 * Known limits, stated rather than papered over:
 *   - An fd number is dropped only when it sits flush against its redirection
 *     (`2>&1`); `2 > file`, which bash reads as an argument anyway, is kept.
 *   - Process substitution `<(cmd)` reads as a redirection, so its body is
 *     skipped rather than scanned. `$( )` and backticks are the shapes that
 *     matter and both are covered.
 */

/** How deep `$( )` nesting is followed before the lexer stops descending. */
const MAX_SUBSTITUTION_DEPTH = 8;

/** Characters that can only end a word: whitespace aside, these begin shell syntax. */
const WORD_TERMINATORS = new Set(["|", "&", ";", "\n", "(", ")", "<", ">"]);

interface Word {
	/** The word with quotes removed and escapes applied. */
	text: string;
	/** Command lines found inside it, from `$( )` or backticks, to be read in turn. */
	nested: string[];
}

/**
 * Every simple command in `command`, in source order, as unquoted words.
 *
 * Commands inside substitutions come out as their own segments, after the
 * segment that contained them, so a caller that walks the result sees a
 * substituted scanner exactly as it would see a top-level one.
 */
export function commandSegments(command: string): string[][] {
	const segments: string[][] = [];
	collect(command, segments, 0);
	return segments;
}

function collect(command: string, out: string[][], depth: number): void {
	if (depth > MAX_SUBSTITUTION_DEPTH) return;
	let words: Word[] = [];
	const flush = (): void => {
		const text = words.map((word) => word.text).filter((value) => value.length > 0);
		if (text.length > 0) out.push(text);
		for (const word of words) for (const nested of word.nested) collect(nested, out, depth + 1);
		words = [];
	};

	// Heredoc tags queue up on the line that opens them and are consumed, in
	// order, by the newline that follows: `cat <<A <<B` takes A's body then B's.
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
			// `2>&1` — the fd rides its redirection and is not an argument.
			if (index === lastWordEnd && words.length > 0 && /^\d+$/.test(words[words.length - 1].text)) words.pop();
			const heredoc = readHeredocTag(command, index);
			if (heredoc !== undefined) {
				pendingHeredocs.push(heredoc.tag);
				index = heredoc.end;
				continue;
			}
			index = skipRedirectionTarget(command, index);
			continue;
		}
		// A subshell or brace group opens a command line of its own; the words
		// before it are complete, the words after it start fresh.
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

/** Whether a `#` here opens a comment: bash only reads one at the start of a word. */
const atWordStart = (command: string, index: number): boolean => index === 0 || /[\s;&|(]/.test(command[index - 1]);

/** One word: quotes stripped, escapes applied, substitutions set aside for the caller. */
function readWord(command: string, start: number): { word: Word; end: number } {
	let text = "";
	const nested: string[] = [];
	let index = start;
	while (index < command.length) {
		const char = command[index];
		if (char === " " || char === "\t" || WORD_TERMINATORS.has(char)) break;
		if (char === "\\") {
			// A backslash before a newline is a line continuation: both vanish and
			// the word carries on, so `find \⏎ /` stays one command.
			if (command[index + 1] === "\n") index += 2;
			else if (index + 1 < command.length) {
				text += command[index + 1];
				index += 2;
			} else index++;
			continue;
		}
		if (char === "'") {
			// Single quotes are literal to the next quote — no escapes inside.
			const close = command.indexOf("'", index + 1);
			if (close === -1) {
				text += command.slice(index + 1);
				return { word: { text, nested }, end: command.length };
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
			index = substitution;
			continue;
		}
		text += char;
		index++;
	}
	return { word: { text, nested }, end: index };
}

/** Inside `"…"`: escapes apply, and substitutions still run. */
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
			index = substitution;
			continue;
		}
		text += char;
		index++;
	}
	return { text, end: index };
}

/** `$( … )` or `` ` … ` `` at `index`: banks the body and returns where it ends. */
function readSubstitution(command: string, index: number, nested: string[]): number | undefined {
	if (command[index] === "`") {
		const close = command.indexOf("`", index + 1);
		nested.push(command.slice(index + 1, close === -1 ? command.length : close));
		return close === -1 ? command.length : close + 1;
	}
	if (command[index] !== "$" || command[index + 1] !== "(") return undefined;
	// `$((…))` is arithmetic, not a command: it holds no program to refuse.
	if (command[index + 2] === "(") return skipBalanced(command, index + 2);
	const read = readBalanced(command, index + 2);
	nested.push(read.text);
	return read.end;
}

/** From just inside an open paren to its match, quotes respected, as text. */
function readBalanced(command: string, start: number): { text: string; end: number } {
	const end = skipBalanced(command, start);
	const close = end <= command.length && command[end - 1] === ")" ? end - 1 : command.length;
	return { text: command.slice(start, close), end };
}

/** The index just past the paren that closes the one opened before `start`. */
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

/** `<<TAG`, `<<-TAG` or `<<'TAG'` — the tag whose body must be skipped, if this is one. */
function readHeredocTag(command: string, index: number): { tag: string; end: number } | undefined {
	const match = /^<<(?!<)-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(index));
	if (match === null) return undefined;
	return { tag: match[1] ?? match[2] ?? match[3], end: index + match[0].length };
}

/**
 * Heredoc bodies are data, not commands.
 *
 * This is the case the old regex got most wrong: writing a file whose text
 * mentions a scan is not running one, and blocking it left the model with a
 * refusal it could not act on.
 */
function skipHeredocBodies(command: string, start: number, pending: string[]): number {
	let index = start;
	while (pending.length > 0) {
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

/** `> file`, `>> file`, `< file`, `>&2` — the operator and the one word it takes. */
function skipRedirectionTarget(command: string, start: number): number {
	let index = start;
	while (index < command.length && (command[index] === "<" || command[index] === ">" || command[index] === "&")) index++;
	while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
	const read = readWord(command, index);
	return read.end === index ? index : read.end;
}
