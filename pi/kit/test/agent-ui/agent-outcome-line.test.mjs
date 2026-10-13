/**
 * The outcome line a finished agent gets, shared by a blocking `Agent` row, a
 * `TaskOutput`/`TaskStop` row and the completion notice: how many tools, how
 * much it wrote, what it cost, or why it failed.
 *
 *   node test/agent-ui/agent-outcome-line.test.mjs
 */

import { finish, is } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
const jiti = kitJiti();

const outcome = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/agent-outcome-line.ts`);

is("one tool is singular", outcome.formatAgentToolUses(1), "1 tool");
is("two tools are plural", outcome.formatAgentToolUses(2), "2 tools");
is("output tokens are written short", outcome.formatAgentOutputTokens(512), "512 out");
is("thousands are abbreviated", outcome.formatAgentOutputTokens(12_300), "12.3k out");
is("millions too", outcome.formatAgentOutputTokens(2_400_000), "2.4M out");
is(
	"a finished agent says how much work, how expensive, how many tools",
	outcome.agentOutcomeLine({ status: "completed", toolUses: 45, outputTokens: 12_300, costUsd: 0.42 }),
	"Done · 45 tools · 12.3k out · $0.42",
);
is(
	"a failed one says why instead",
	outcome.agentOutcomeLine({ status: "error", toolUses: 45, outputTokens: 12_300, costUsd: 0.42, error: "ENOENT: no such file\nat foo" }),
	"Failed · ENOENT: no such file",
);
is("a zero count is not a fact worth reporting", outcome.agentOutcomeLine({ status: "completed", toolUses: 0, outputTokens: 0, costUsd: 0 }), "Done");
is("sub-cent spend is still spend", outcome.agentOutcomeLine({ status: "completed", toolUses: 1, outputTokens: 20, costUsd: 0.001 }), "Done · 1 tool · 20 out · <$0.01");

await finish();
