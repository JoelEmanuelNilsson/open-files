/**
 * `/compact-at` (`extensions/compact-at/index.ts`): parses the value, writes or removes the model's
 * reserveTokens in the settings file of a temp agent dir, refuses while the seat's agents, background
 * tasks or workflow runs live, and reloads after a write.
 */

import { check, finish } from "../support/check-harness.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";

const jiti = kitJiti({ moduleCache: false });
const { markAgentLive, markAgentSettled } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
const { adoptBackgroundTask, endBackgroundTasksOf } = await jiti.import(`${KIT_ROOT}/lib/tools/background-tasks.ts`);
const compactAt = await jiti.import(`${KIT_ROOT}/extensions/compact-at/index.ts`, { default: true });

const agentDir = mkdtempSync(join(tmpdir(), "compact-at-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const file = join(agentDir, "settings.json");
const original = { defaultModel: "opus", compaction: { enabled: true, modelOverrides: { "other/model": { reserveTokens: 7 }, "anthropic/opus": { reserveTokens: 500_000, keepRecentTokens: 9 } } }, theme: "ansi" };
const reset = () => writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
const read = () => JSON.parse(readFileSync(file, "utf8"));
reset();

const pi = fakeExtensionApi();
compactAt(pi.api);
const command = pi.commands.get("compact-at");

const SESSION = "main-compact-at";
const OPUS = { provider: "anthropic", id: "opus", contextWindow: 1_000_000 };
function run(args, model = OPUS) {
	const notices = [];
	let reloads = 0;
	const ctx = {
		model: model ?? undefined,
		cwd: agentDir,
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (message, level) => notices.push(`${level}: ${message}`) },
		reload: async () => void reloads++,
	};
	return command.handler(args, ctx).then(() => ({ notices, reloads }));
}

let result = await run("300k");
check("300k writes reserveTokens window - 300000 for the current model", read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 700_000, JSON.stringify(read()));
check("a write keeps every other key and the model's other settings", JSON.stringify(read()).includes('"other/model":{"reserveTokens":7}') && read().compaction.modelOverrides["anthropic/opus"].keepRecentTokens === 9 && read().theme === "ansi" && read().compaction.enabled === true);
check("a write keeps the file's indent and final newline", readFileSync(file, "utf8").startsWith('{\n  "defaultModel"') && readFileSync(file, "utf8").endsWith("}\n"));
check("a write reloads once and says when it applies", result.reloads === 1 && result.notices[0].includes("this session now") && result.notices[0].includes("others"), result.notices.join());

result = await run("250000");
check("a plain number is tokens", read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 750_000);

result = await run("");
check("no argument shows the value and reloads nothing", result.reloads === 0 && result.notices[0].includes("compact_at 250000") && read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 750_000, result.notices.join());

for (const [name, args] of [["text", "lots"], ["a decimal", "1.5k"], ["a negative", "-5"], ["below the floor", "19999"], ["the window", "1000000"], ["past the window", "2000k"]]) {
	result = await run(args);
	check(`${name} is refused, writes nothing and reloads nothing`, result.reloads === 0 && result.notices[0].startsWith("error:") && read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 750_000, result.notices.join());
}
result = await run("20k");
check("the floor itself is accepted", read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 980_000 && result.reloads === 1);

result = await run("default");
check("default removes only that model's reserveTokens, and reloads", read().compaction.modelOverrides["anthropic/opus"].keepRecentTokens === 9 && read().compaction.modelOverrides["anthropic/opus"].reserveTokens === undefined && read().compaction.modelOverrides["other/model"].reserveTokens === 7 && result.reloads === 1);
await run("300k");
writeFileSync(file, `${JSON.stringify({ compaction: { modelOverrides: { "anthropic/opus": { reserveTokens: 1 } } } }, null, "\t")}\n`);
await run("default");
check("default drops the emptied override and its parent, keeping the file's tabs", readFileSync(file, "utf8") === '{\n\t"compaction": {}\n}\n', readFileSync(file, "utf8"));

reset();
markAgentLive(SESSION, "task-1");
adoptBackgroundTask(SESSION, { id: 1, command: "sleep 99", logPath: join(agentDir, "bg.log") }, { kill: () => true, exitedWith: undefined }, () => "appended", Date.now());
result = await run("300k");
check("a live agent and background task refuse the change, name both, write and reload nothing", result.reloads === 0 && result.notices[0].includes("1 agents and 1 background tasks") && read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 500_000, result.notices.join());
markAgentSettled(SESSION, "task-1");
endBackgroundTasksOf(SESSION);
result = await run("300k");
check("once they end the change goes through", result.reloads === 1 && read().compaction.modelOverrides["anthropic/opus"].reserveTokens === 700_000, result.notices.join());

result = await run("300k", null);
check("no model is refused", result.reloads === 0 && result.notices[0].startsWith("error:"));

await finish();
