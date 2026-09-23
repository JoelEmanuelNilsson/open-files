/**
 * Do the two comment rules ban the essays and the narration, and nothing else?
 * The decision runs here, not the plugin: oxlint never lives in the kit.
 *
 *   node test/comment-lint.mjs
 */

import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const { commentBlocks, commentLineCap, DEFAULT_NARRATING_OPENERS, narratingOpener, narratingOpeners } =
	await jiti.import(`${ROOT}/skills/install-anti-slop/assets/anti-slop/shared/comment-blocks.ts`);

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

/** Fixture source into the parser's comment list. Fixtures carry no literal a scan could mistake for one. */
function commentsOf(source) {
	const lines = source.split("\n");
	const comments = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const lineStart = line.indexOf("//");
		const blockStart = line.indexOf("/*");
		if (blockStart >= 0 && (lineStart < 0 || blockStart < lineStart)) {
			let end = index;
			while (!lines[end].includes("*/")) end++;
			const body = [lines[index].slice(blockStart + 2), ...lines.slice(index + 1, end + 1)].join("\n");
			comments.push({
				type: "Block",
				value: body.slice(0, body.lastIndexOf("*/")),
				loc: { start: { line: index + 1, column: blockStart }, end: { line: end + 1 } },
			});
			index = end;
			continue;
		}
		if (lineStart < 0) continue;
		comments.push({
			type: "Line",
			value: line.slice(lineStart + 2),
			loc: { start: { line: index + 1, column: lineStart }, end: { line: index + 1 } },
		});
	}
	return comments;
}

const blocksOf = (source) => commentBlocks(commentsOf(source));
const cap = commentLineCap(undefined);
const essaysIn = (source) => blocksOf(source).filter((block) => block.proseLines.length > cap);
const narrationIn = (source, openers = narratingOpeners(undefined)) =>
	blocksOf(source).flatMap((block) => {
		const opener = narratingOpener(block, openers);
		return opener === undefined ? [] : [opener];
	});

console.log("the scanner the fixtures rest on");
{
	const comments = commentsOf(["/* one", "   two */", "const a = 1; // trailing"].join("\n"));
	check("a block comment spans its lines", comments[0].type === "Block" && comments[0].loc.end.line === 2);
	check("a trailing line comment keeps its column", comments[1].type === "Line" && comments[1].loc.start.column === 13, JSON.stringify(comments[1]));
}

console.log("\nno-comment-essay — the cap is three lines of prose");
{
	const four = [
		"// A run of four lines that says nothing the code does not say,",
		"// spread over enough lines that the reader skips it, and the",
		"// next reader deletes it, which is exactly the essay this rule",
		"// exists to reject.",
		"export const x = 1;",
	].join("\n");
	const flagged = essaysIn(four);
	check("a four-line run of // lines is one block, and it errors", flagged.length === 1 && flagged[0].proseLines.length === 4, JSON.stringify(flagged));
	check("reported at the block's first line", flagged[0]?.startLine === 1 && flagged[0]?.startColumn === 0);

	const three = ["// Anthropic keys the cache on these bytes, so one changed", "// byte is a full-price rewrite of the whole prefix, which is", "// why the payload is captured rather than rebuilt.", "export const y = 1;"].join("\n");
	check("a three-line block passes", essaysIn(three).length === 0);

	const jsdoc = ["/**", " * Send one ping and report what happened.", " *", " * Never throws: every way this fails is a caller decision.", " */", "export function ping() {}"].join("\n");
	check("a blank JSDoc line is not prose, so this two-line one passes", essaysIn(jsdoc).length === 0, JSON.stringify(blocksOf(jsdoc)));

	const long = ["/**", " * one", " * two", " * three", " * four", " */", "export const z = 1;"].join("\n");
	check("a four-line JSDoc errors", essaysIn(long).length === 1);

	const apart = ["// A why on its own.", "export const a = 1;", "", "// Another why, two lines below.", "export const b = 2;"].join("\n");
	check("comments separated by code are separate blocks", blocksOf(apart).length === 2 && essaysIn(apart).length === 0);

	check("the cap is tunable through options", commentLineCap({ maxLines: 1 }) === 1 && commentLineCap({ maxLines: 0 }) === cap && cap === 3);
}

console.log("\nno-narrating-comment — say why, not what");
{
	for (const opener of ["This function", "Here we", "Note that", "First,"]) {
		check(`"${opener}" errors`, narrationIn(`// ${opener} does the thing.\nexport const v = 1;`)[0] === opener);
	}
	const missed = DEFAULT_NARRATING_OPENERS.filter(
		(opener) => narrationIn(`// ${opener} the thing it does.\nexport const v = 1;`).length === 0,
	);
	check("every default opener is caught", missed.length === 0, missed.join(", "));

	check("a why passes", narrationIn("// Anthropic keys the cache on these bytes.\nexport const w = 1;").length === 0);
	check("a one-line JSDoc on an export passes", narrationIn("/** Send one ping and report what happened. */\nexport function ping() {}").length === 0);
	check("an opener needs a word boundary", narrationIn("// This functionality moved to wire.ts.\nexport const n = 1;").length === 0);
	check("narration inside a JSDoc errors", narrationIn("/** This function sums the inputs. */\nexport function sum() {}")[0] === "This function");
	check("openers are tunable through options", narrationIn("// Kludge for the gateway.\nexport const k = 1;", narratingOpeners({ openers: ["Kludge"] }))[0] === "Kludge");
	check("an unusable openers option falls back to the defaults", narratingOpeners({ openers: [] }) === DEFAULT_NARRATING_OPENERS);
}

console.log("\nwhat neither rule may touch");
{
	const licence = ["/*", " * Copyright (c) 2026 Someone", " * All rights reserved. This licence header runs on for several", " * lines and none of them may be reported, however it opens.", " */", "export const l = 1;"].join("\n");
	check("a licence header is not a block at all", blocksOf(licence).length === 0, JSON.stringify(blocksOf(licence)));

	for (const directive of ["eslint-disable no-console", "oxlint-disable-next-line no-console", "@ts-expect-error the shim lies", "prettier-ignore"]) {
		check(`the ${directive.split(" ")[0]} directive passes`, blocksOf(`// ${directive}\nexport const d = 1;`).length === 0);
	}

	const safety = [
		"// SAFETY: the registry resolved this id one line above, and the map",
		"// is written only here, so the entry cannot be missing between the",
		"// two statements, which is more justification than the cap allows",
		"// and is exempt for that reason.",
		"const value = target;",
	].join("\n");
	check("a four-line SAFETY justification passes", blocksOf(safety).length === 0);

	const disableInRun = ["// A why.", "// eslint-disable-next-line no-console", "// Another why.", "export const r = 1;"].join("\n");
	check("a directive splits a run rather than joining it", blocksOf(disableInRun).length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
