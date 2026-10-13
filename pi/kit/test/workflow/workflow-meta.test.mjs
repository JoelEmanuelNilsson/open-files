/**
 * A workflow script's `meta`, offline: a pure literal read by
 * `extractWorkflowMeta`, or a loud refusal naming the rule.
 */

import { check, checkThrows, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
// 1. meta: a pure literal, or a loud refusal
// ---------------------------------------------------------------------------
{
	const { extractWorkflowMeta } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-meta.ts`);
	console.log("\nmeta extraction");
	const source = [
		"// leading comment",
		"export const meta = {",
		"  name: 'review-changes',",
		"  description: \"Review changed files across dimensions, verify each finding\",",
		"  whenToUse: `when asked`,",
		"  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'a {brace} in a string', model: 'sonnet' }], // trailing comment",
		"  count: 3, ratio: -1.5, on: true, off: false, none: null,",
		"};",
		"const x = await agent('hi');",
		"return x;",
	].join("\n");
	const out = extractWorkflowMeta(source);
	check("reads name and description", out.meta.name === "review-changes" && out.meta.description === "Review changed files across dimensions, verify each finding");
	check("reads nested arrays of objects, with a brace inside a string", out.meta.phases.length === 2 && out.meta.phases[1].detail === "a {brace} in a string" && out.meta.phases[1].model === "sonnet", JSON.stringify(out.meta.phases));
	check("reads numbers, booleans, null and a template string without interpolation", out.meta.count === 3 && out.meta.ratio === -1.5 && out.meta.on === true && out.meta.off === false && out.meta.none === null && out.meta.whenToUse === "when asked");
	check("the body is the script minus the meta declaration", out.body.includes("const x = await agent('hi');") && !out.body.includes("export const meta") && out.body.startsWith("// leading comment"), out.body.slice(0, 60));
	check("a semicolon-less declaration works too", extractWorkflowMeta("export const meta = { name: 'a', description: 'b' }\nreturn 1").meta.name === "a");
	await checkThrows("a variable in meta is refused, naming the rule", () => extractWorkflowMeta("export const meta = { name: n, description: 'b' }"), "meta must be a pure literal");
	await checkThrows("a statement before the meta is refused", () => extractWorkflowMeta("const n = 'a'\nexport const meta = { name: 'a', description: 'b' }"), "script must begin with");
	await checkThrows("a comment quoting the declaration is not the meta", () => extractWorkflowMeta("// export const meta = { name: 'x', description: 'y' }\nreturn 1"), "script must begin with");
	await checkThrows("a string quoting the declaration is not the meta", () => extractWorkflowMeta("const s = 'export const meta = { name: 1'\nexport const meta = { name: 'a', description: 'b' }"), "script must begin with");
	await checkThrows("a call in meta is refused", () => extractWorkflowMeta("export const meta = { name: 'a'.trim(), description: 'b' }"), "meta must be a pure literal");
	await checkThrows("a spread in meta is refused", () => extractWorkflowMeta("export const meta = { ...base, name: 'a', description: 'b' }"), "meta must be a pure literal");
	await checkThrows("template interpolation in meta is refused", () => extractWorkflowMeta("export const meta = { name: `a${1}`, description: 'b' }"), "meta must be a pure literal");
	await checkThrows("a script without meta is refused", () => extractWorkflowMeta("const meta = { name: 'a' }\nreturn 1"), "script must begin with `export const meta = {...}`");
	await checkThrows("meta without a name is refused", () => extractWorkflowMeta("export const meta = { description: 'b' }"), "meta needs name and description");
	await checkThrows("meta without a description is refused", () => extractWorkflowMeta("export const meta = { name: 'a' }"), "meta needs name and description");
	await checkThrows("an unterminated meta is refused", () => extractWorkflowMeta("export const meta = { name: 'a', description: 'b'"), "meta must be a pure literal");
	for (const literal of ["'\\u{1F600} \\u00e9 \\x41!'", "'one \\\ntwo'", "`one \\\r\ntwo \\u{41}`", "\"tab\\there \\0 end\""]) {
		const read = extractWorkflowMeta(`export const meta = { name: ${literal}, description: 'b' }`).meta.name;
		const js = new Function(`return ${literal}`)();
		check(`a meta string reads as JavaScript reads it: ${JSON.stringify(literal)}`, read === js, `${JSON.stringify(read)} vs ${JSON.stringify(js)}`);
	}
	await checkThrows("a malformed escape in meta is refused", () => extractWorkflowMeta("export const meta = { name: '\\u{zz}', description: 'b' }"), "meta must be a pure literal");
	await checkThrows("a TypeScript annotation is refused as not pure", () => extractWorkflowMeta("export const meta: Meta = { name: 'a', description: 'b' }"), "script must begin with `export const meta = {...}`");
}

await finish();
