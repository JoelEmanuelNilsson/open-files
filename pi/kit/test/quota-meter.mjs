/**
 * The quota meter: what the `anthropic-ratelimit-unified-*` headers say, how
 * the bar renders them, and how per-agent spend rolls up into `/stats`.
 *
 * The header parse is pinned against the shapes the installed `claude`
 * 2.1.259 binary reads, because the numbers are the whole instrument: a
 * utilization read as a percent instead of a fraction is a meter that says 34%
 * when the account is at 34 hundredths of one percent.
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "../..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const meter = await jiti.import(`${ROOT}/lib/quota-meter.ts`);
const spend = await jiti.import(`${ROOT}/lib/agent-spend.ts`);

/**
 * One "now" for every parse below, and reset headers written against it. The
 * parse drops a reset already past, so a fixture with a hard-coded epoch
 * passes until that epoch arrives and then fails on its own — which is what
 * happened on 2026-09-03, when the wire test's `1788470000` went by and "all
 * five headers survive to disk" went red with no line of code changing.
 * Anchored to the wall clock, the fixture cannot rot.
 */
const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);
/** Comfortably in the future, in unix seconds, on any machine that runs this. */
const FIVE_HOUR_RESET_SEC = NOW_SEC + 70_000;
const SEVEN_DAY_RESET_SEC = NOW_SEC + 500_000;

/** A full header bag, as Anthropic sends it on a subscription response. */
const HEADERS = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-5h-utilization": "0.34",
	"anthropic-ratelimit-unified-7d-utilization": "0.61",
	"anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET_SEC),
	"anthropic-ratelimit-unified-7d-reset": String(SEVEN_DAY_RESET_SEC),
	"anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
	"request-id": "req_abc",
};

// ---------------------------------------------------------------------------
console.log("quota-meter: the five headers ticket 13 records");
{
	const reading = meter.readQuotaHeaders(HEADERS, NOW_MS);
	check("a subscription response reads", reading !== undefined);
	check("5h utilization is the fraction, not a percent", reading.fiveHourUtilization === 0.34);
	check("7d utilization is the fraction", reading.sevenDayUtilization === 0.61);
	check("5h reset is unix seconds", reading.fiveHourResetAtSec === FIVE_HOUR_RESET_SEC);
	check("7d reset is unix seconds", reading.sevenDayResetAtSec === SEVEN_DAY_RESET_SEC);
	check("the representative claim is carried whole", reading.representativeClaim === "seven_day_overage_included");
	check("nothing else is picked up", Object.keys(reading).sort().join(",") ===
		"fiveHourResetAtSec,fiveHourUtilization,representativeClaim,sevenDayResetAtSec,sevenDayUtilization",
		Object.keys(reading).sort().join(","));
}

// ---------------------------------------------------------------------------
console.log("\nquota-meter: headers that are not a quota reading");
{
	check("a response with no ratelimit headers reads nothing", meter.readQuotaHeaders({ "request-id": "req_abc" }, NOW_MS) === undefined);
	check("an empty bag reads nothing", meter.readQuotaHeaders({}, NOW_MS) === undefined);
	check("a claim on its own is still a reading", meter.readQuotaHeaders({ "anthropic-ratelimit-unified-representative-claim": "five_hour" }, NOW_MS)?.representativeClaim === "five_hour");
	const partial = meter.readQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, NOW_MS);
	check("a half-filled bag keeps only what was sent", partial.fiveHourUtilization === 0.5 && partial.sevenDayUtilization === undefined);
}

// ---------------------------------------------------------------------------
console.log("\nquota-meter: values the header can carry but the number cannot");
{
	const junk = meter.readQuotaHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "not-a-number",
		"anthropic-ratelimit-unified-7d-utilization": "0.61",
	}, NOW_MS);
	check("an unparseable utilization is dropped, not zeroed", junk.fiveHourUtilization === undefined && junk.sevenDayUtilization === 0.61);
	const clamped = meter.readQuotaHeaders({
		"anthropic-ratelimit-unified-5h-utilization": "1.4",
		"anthropic-ratelimit-unified-7d-utilization": "-0.2",
	}, NOW_MS);
	check("utilization is clamped to 0..1, the way the binary clamps it", clamped.fiveHourUtilization === 1 && clamped.sevenDayUtilization === 0);
	check("a zero reset is not a timestamp", meter.readQuotaHeaders({ "anthropic-ratelimit-unified-5h-reset": "0" }, NOW_MS) === undefined);
	check("a reset already past is dropped", meter.readQuotaHeaders({ "anthropic-ratelimit-unified-5h-reset": String(NOW_SEC - 1) }, NOW_MS) === undefined);
	// Header bags arrive lower-cased from pi (`headersToRecord`), but a proxy
	// that title-cases them must not silently blank the meter.
	const upper = meter.readQuotaHeaders({ "Anthropic-RateLimit-Unified-5h-Utilization": "0.34" }, NOW_MS);
	check("header names are matched case-insensitively", upper?.fiveHourUtilization === 0.34);
}

// ---------------------------------------------------------------------------
console.log("\nquota-meter: how the reading reads when it is asked for");
{
	const reading = meter.readQuotaHeaders(HEADERS, NOW_MS);
	check("the two windows read `5h 34% · 7d 61%`", meter.quotaStatusLabel(reading) === "5h 34% · 7d 61%", meter.quotaStatusLabel(reading));
	check("a fraction rounds to whole percent", meter.quotaStatusLabel({ fiveHourUtilization: 0.3449, sevenDayUtilization: 0.615 }) === "5h 34% · 7d 62%");
	check("one window alone still shows", meter.quotaStatusLabel({ fiveHourUtilization: 0.02 }) === "5h 2%");
	check("a reading with no utilization shows nothing", meter.quotaStatusLabel({ representativeClaim: "five_hour" }) === "");
	check("no reading shows nothing", meter.quotaStatusLabel(undefined) === "");
	check("exhausted reads 100%, never a rounded 99", meter.quotaStatusLabel({ fiveHourUtilization: 1 }) === "5h 100%");

	// The on-demand report: the windows, then whatever else is known.
	const full = meter.quotaReport(reading);
	check("the report leads with the two windows", full.startsWith("5h 34% · 7d 61% ("), full);
	check("the report names both resets and the binding claim",
		full.includes("5h resets ") && full.includes("7d resets ") && full.includes("binding seven_day_overage_included"), full);
	check("a reading with no resets is just the windows", meter.quotaReport({ fiveHourUtilization: 0.01, sevenDayUtilization: 0.19 }) === "5h 1% · 7d 19%");
	check("nothing read yet reports nothing", meter.quotaReport(undefined) === undefined);
	check("an empty reading reports nothing", meter.quotaReport({}) === undefined);
}

// ---------------------------------------------------------------------------
console.log("\nagent-spend: money, spelled one way");
{
	check("a dollar amount is two decimals", spend.formatSpendUsd(1.239) === "$1.24");
	check("cents keep two decimals", spend.formatSpendUsd(0.42) === "$0.42");
	check("sub-cent spend is not rounded to zero", spend.formatSpendUsd(0.004) === "<$0.01");
	check("nothing spent is nothing shown", spend.formatSpendUsd(0) === "");
	check("an unknown cost is nothing shown", spend.formatSpendUsd(undefined) === "");
	check("thousands stay readable", spend.formatSpendUsd(1234.5) === "$1,234.50");
}

// ---------------------------------------------------------------------------
console.log("\nagent-spend: the /stats tree");
{
	const lines = spend.renderAgentSpendTree({
		ownDollars: 2.41,
		agents: [
			{ label: "worker Research: prices", dollars: 0.42, live: false },
			{ label: "Explore Find the defect", dollars: 0.08, live: false },
			{ label: "worker Build the meter", dollars: 0, live: true },
		],
	});
	check("the seat's own spend heads the tree", lines[0] === "main                      $2.41", JSON.stringify(lines[0]));
	check("every agent is a branch", lines[1].startsWith("├ ") && lines[2].startsWith("├ ") && lines[3].startsWith("└ "), JSON.stringify(lines.slice(1, 4)));
	check("a live agent says so instead of claiming $0", lines[3].includes("running") && !lines[3].includes("$"), JSON.stringify(lines[3]));
	check("the total is the seat plus every agent", lines[lines.length - 1] === "total                     $2.91", JSON.stringify(lines[lines.length - 1]));
	const alone = spend.renderAgentSpendTree({ ownDollars: 0.5, agents: [] });
	check("no agents means no tree, just the seat", alone.length === 1 && alone[0] === "main                      $0.50", JSON.stringify(alone));
}

// ---------------------------------------------------------------------------
console.log("\nthe 1h cache write price ticket 01 pinned, now pi's to derive");
{
	// `pi/models.json` carried `cacheWrite1h: 20` for Fable 5.1 until 2026-09-20.
	// pi never read that field: `calculateCost` bills a 1h write at twice base
	// input, which is the same $20. Deleting the override cost nothing, and this
	// is the reading that says so.
	const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
	const { calculateCost } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/models.js`);
	const catalog = JSON.parse(fs.readFileSync(`${PI}/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json`, "utf8"))["anthropic-messages"];
	const fable = catalog["claude-fable-5-1"];
	check("pi ships Fable 5.1 at the prices the override typed by hand",
		fable?.cost?.input === 10 && fable?.cost?.output === 50 && fable?.cost?.cacheRead === 0.25 && fable?.cost?.cacheWrite === 12.5,
		JSON.stringify(fable?.cost));
	check("and no cacheWrite1h on it, because pi does not read one", fable?.cost?.cacheWrite1h === undefined);

	const bill = (write1h) => {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: write1h, cost: {} };
		calculateCost(fable, usage);
		return usage.cost.cacheWrite;
	};
	check("a megatoken of 1h writes still bills $20", bill(1_000_000) === 20, String(bill(1_000_000)));
	check("a megatoken of 5m writes bills the catalog's $12.50", bill(0) === 12.5, String(bill(0)));
}

// ---------------------------------------------------------------------------
// The instrument is only worth anything wired up: the headers have to reach the
// trace and `/quota` off a real response, through the one extension that holds
// the request. Driven through a stand-in ExtensionAPI, the same way
// `test/wire-trace.mjs` drives the trace.
//
// The bottom rule is the contract that matters here. Joel ruled the quota label
// off it — the numbers are for diagnosis on demand — so the test pins that no
// status is written at all, not merely that it reads well.
console.log("\nwire: the meter reads the response the harness already had");
{
	const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "quota-meter-test-"));
	process.env.PI_WIRE_TRACE_DIR = DIR;
	const wireMod = await jiti.import(`${ROOT}/extensions/wire.ts?quota`);
	const handlers = new Map();
	const commands = new Map();
	wireMod.default({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	const statuses = new Map();
	const notices = [];
	const ctx = {
		model: { id: "claude-test", api: "anthropic-messages" },
		modelRegistry: { isUsingOAuth: () => true, find: (provider, id) => ({ provider, id }) },
		sessionManager: { getSessionId: () => "session-quota", getHeader: () => ({ id: "session-quota" }) },
		hasUI: true,
		cwd: "/tmp",
		ui: { setStatus: (key, value) => statuses.set(key, value), notify: (text) => notices.push(text), theme: { fg: (_c, s) => s } },
	};

	check("nothing has been read before the first response", (await runQuota(commands, ctx, notices)).startsWith("No quota headers seen yet"));

	handlers.get("after_provider_response")({ status: 200, headers: HEADERS }, ctx);
	check("no quota status reaches the bottom rule", statuses.size === 0, [...statuses.keys()].join(","));
	const asked = await runQuota(commands, ctx, notices);
	check("`/quota` prints the two windows on demand", asked.startsWith("Quota 5h 34% · 7d 61%"), asked);
	check("`/quota` prints the resets it knows", asked.includes("5h resets ") && asked.includes("7d resets "), asked);

	// A response without the headers is not a fresh allowance. Forgetting the
	// reading on one would blank the answer every time a proxy or a side request
	// answered without them.
	handlers.get("after_provider_response")({ status: 200, headers: { "request-id": "req_2" } }, ctx);
	check("a response with no quota headers leaves the last reading standing", (await runQuota(commands, ctx, notices)).startsWith("Quota 5h 34% · 7d 61%"));
	check("the bottom rule is still untouched", statuses.size === 0, [...statuses.keys()].join(","));

	const payload = {
		system: [{ type: "text", text: "vanilla", cache_control: { type: "ephemeral", ttl: "1h" } }],
		tools: [{ name: "Read", input_schema: { type: "object" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
	};
	handlers.get("before_provider_request")({ payload }, ctx);
	handlers.get("message_end")({ message: { role: "assistant", usage: { input: 4, cacheRead: 0, cacheWrite: 9033 } } }, ctx);

	const log = fs.readFileSync(path.join(DIR, "session-quota.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const use = log.find((record) => record.t === "use");
	check("the quota reading is recorded beside the token counts", use.read === 0 && use.write === 9033 && use.quota !== undefined, JSON.stringify(use));
	check("all five headers survive to disk",
		use.quota.fiveHourUtilization === 0.34 && use.quota.sevenDayUtilization === 0.61 &&
		use.quota.fiveHourResetAtSec === FIVE_HOUR_RESET_SEC && use.quota.sevenDayResetAtSec === SEVEN_DAY_RESET_SEC &&
		use.quota.representativeClaim === "seven_day_overage_included",
		JSON.stringify(use.quota));

	// A second response with no headers must not re-file the first one's numbers
	// against it: a stale reading on a fresh request is a lie the delta is read
	// off later.
	handlers.get("before_provider_request")({ payload }, ctx);
	handlers.get("message_end")({ message: { role: "assistant", usage: { input: 4, cacheRead: 9033, cacheWrite: 20 } } }, ctx);
	const second = fs.readFileSync(path.join(DIR, "session-quota.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.t === "use").at(-1);
	check("a response that reported no quota records none", second.quota === undefined, JSON.stringify(second));

	fs.rmSync(DIR, { recursive: true, force: true });
}

/** Run `/quota` and return what it told the seat. */
async function runQuota(commands, ctx, notices) {
	await commands.get("quota").handler("", ctx);
	return notices.at(-1) ?? "";
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
