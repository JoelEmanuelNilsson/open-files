/**
 * The `Workflow` tool's ruled words: Claude Code's description with our gate,
 * under budget, pinned so they change only with this file.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { estimateWorkflowTextTokens } from "../support/workflow-text-budget.mjs";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
// 5. the ruled words: Claude Code's description with our gate, under budget
// ---------------------------------------------------------------------------
{
	const t = await jiti.import(`${KIT_ROOT}/extensions/workflow/workflow-tool-text.ts`);
	console.log("\nthe ruled words");
	const d = t.WORKFLOW_DESCRIPTION;
	check("the opt-in gate is gone (C20): no ultracode, no 'explicitly opted', no size guideline", !/ultracode|explicitly opted|ONLY call this tool|under 50 agents/.test(d));
	check("a model cannot run a slash command, so the description does not send it to one", !d.includes("/workflows"));
	check("points at the workflow-authoring skill", d.includes("load the `workflow-authoring` skill"));
	const tokens = estimateWorkflowTextTokens(d);
	check(`the description is under ~500 tokens (chars/4 = ${tokens.byFour}, chars/3.7 = ${tokens.byThreeSeven})`, tokens.byThreeSeven <= 520, `${d.length} chars`);
	const all = d + Object.values(t.WORKFLOW_PARAMS).join("\n");
	const allTokens = estimateWorkflowTextTokens(all);
	check(`with the parameter descriptions: chars/4 = ${allTokens.byFour}, chars/3.7 = ${allTokens.byThreeSeven}`, allTokens.byThreeSeven <= 800);
	check("wake is gone: a workflow's return value delivers itself (ticket 09, ruled)", t.WORKFLOW_PARAMS.wake === undefined, Object.keys(t.WORKFLOW_PARAMS).join());
	check("the run id pattern is Claude Code's", t.WORKFLOW_RUN_ID_PATTERN === "^wf_[a-z0-9-]{6,}$" && t.WORKFLOW_SCRIPT_MAX_LENGTH === 524288);
}

await finish();
