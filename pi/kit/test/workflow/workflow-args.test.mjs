/**
 * Workflow args, offline: a JSON string that encodes an object or an array is
 * that value (ticket 55).
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
// 4b. args: a JSON string that encodes an object or an array *is* that value (ticket 55)
// ---------------------------------------------------------------------------
{
	const { coerceWorkflowArgs } = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-args.ts`);
	console.log("\nargs coercion");
	const object = coerceWorkflowArgs('{"tests":["a.ts"],"n":2}');
	check("a JSON-string object arrives as the object", object.coerced === true && object.value.tests[0] === "a.ts" && object.value.n === 2, JSON.stringify(object));
	const array = coerceWorkflowArgs("[1,2]");
	check("a JSON-string array arrives as the array", array.coerced === true && Array.isArray(array.value) && array.value.length === 2);
	check("text that is not JSON stays the string it is", coerceWorkflowArgs("plain text").value === "plain text" && coerceWorkflowArgs("plain text").coerced === false);
	check("a JSON scalar stays the string it is: a script may want one", ["7", "true", "null", '"quoted"'].every((s) => coerceWorkflowArgs(s).value === s && coerceWorkflowArgs(s).coerced === false));
	check("a real object, a real array and undefined pass through untouched", coerceWorkflowArgs({ a: 1 }).value.a === 1 && coerceWorkflowArgs([3]).value[0] === 3 && coerceWorkflowArgs(undefined).value === undefined && [{ a: 1 }, [3], undefined].every((v) => coerceWorkflowArgs(v).coerced === false));
}

await finish();
