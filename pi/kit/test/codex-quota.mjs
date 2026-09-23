/**
 * The Codex quota meter: what the `x-codex-*` headers of a ChatGPT-subscription
 * response say, read the way the Codex CLI reads them
 * (`codex-rs/codex-api/src/rate_limits.rs`), and how `/quota` words them.
 * The fixture is the header set a live `openai-codex/gpt-6-luna` response
 * carried over SSE on 2026-09-22, with the resets moved onto the wall clock.
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const meter = await jiti.import(`${ROOT}/lib/quota-meter.ts`);

const NOW_MS = Date.now();
const NOW_SEC = Math.floor(NOW_MS / 1000);
const PRIMARY_RESET_SEC = NOW_SEC + 16_503;
const SECONDARY_RESET_SEC = NOW_SEC + 603_303;

const HEADERS = {
	"x-codex-active-limit": "premium",
	"x-codex-credits-balance": "0",
	"x-codex-credits-has-credits": "False",
	"x-codex-plan-type": "plus",
	"x-codex-primary-over-secondary-limit-percent": "0",
	"x-codex-primary-reset-after-seconds": "16503",
	"x-codex-primary-reset-at": String(PRIMARY_RESET_SEC),
	"x-codex-primary-used-percent": "12.5",
	"x-codex-primary-window-minutes": "300",
	"x-codex-secondary-reset-after-seconds": "603303",
	"x-codex-secondary-reset-at": String(SECONDARY_RESET_SEC),
	"x-codex-secondary-used-percent": "40",
	"x-codex-secondary-window-minutes": "10080",
};

console.log("codex-quota: the two windows");
{
	const reading = meter.readCodexQuotaHeaders(HEADERS, NOW_MS);
	check("used-percent is a percent, read as a fraction", reading?.primary?.utilization === 0.125 && reading.secondary?.utilization === 0.4, JSON.stringify(reading));
	check("each window carries its length", reading.primary.windowMinutes === 300 && reading.secondary.windowMinutes === 10080);
	check("each window carries its reset in unix seconds", reading.primary.resetAtSec === PRIMARY_RESET_SEC && reading.secondary.resetAtSec === SECONDARY_RESET_SEC);
	check("and nothing but the two windows", JSON.stringify(Object.keys(reading).sort()) === '["primary","secondary"]');
	check("it is not an anthropic reading", meter.readQuotaHeaders(HEADERS, NOW_MS) === undefined);
	check("and an anthropic response is not a codex one", meter.readCodexQuotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.34" }, NOW_MS) === undefined);
}

console.log("codex-quota: absence is never zero");
{
	check("a response with no codex headers reads nothing", meter.readCodexQuotaHeaders({ "content-type": "text/event-stream" }, NOW_MS) === undefined);
	check("a zero with no length and no reset is no window", meter.readCodexQuotaHeaders({ "x-codex-primary-used-percent": "0" }, NOW_MS) === undefined);
	check("a zero with a length is a fresh window", meter.readCodexQuotaHeaders({ "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "300" }, NOW_MS)?.primary?.utilization === 0);
	check("a window with no used-percent is no window", meter.readCodexQuotaHeaders({ "x-codex-primary-window-minutes": "300" }, NOW_MS) === undefined);
	check("an unparseable used-percent is dropped", meter.readCodexQuotaHeaders({ "x-codex-primary-used-percent": "lots", "x-codex-primary-window-minutes": "300" }, NOW_MS) === undefined);
	const past = meter.readCodexQuotaHeaders({ "x-codex-primary-used-percent": "5", "x-codex-primary-reset-at": String(NOW_SEC - 1) }, NOW_MS);
	check("a reset already past is dropped, the window kept", past?.primary?.utilization === 0.05 && past.primary.resetAtSec === undefined);
	check("used-percent is clamped to 0..100", meter.readCodexQuotaHeaders({ "x-codex-primary-used-percent": "140", "x-codex-primary-window-minutes": "300" }, NOW_MS)?.primary?.utilization === 1);
	check("header names are matched case-insensitively", meter.readCodexQuotaHeaders({ "X-Codex-Secondary-Used-Percent": "7" }, NOW_MS)?.secondary?.utilization === 0.07);
}

console.log("codex-quota: the /quota line");
{
	const line = meter.codexQuotaReport(meter.readCodexQuotaHeaders(HEADERS, NOW_MS));
	check("the windows are named by their length, in Anthropic's words", /^5h 13% · 7d 40% \(5h resets [^,]+, 7d resets [^)]+\)$/.test(line ?? ""), line);
	check("a window with no length is named by its slot", meter.codexQuotaReport({ primary: { utilization: 0.02 } }) === "primary 2%");
	check("an odd length is said in minutes", meter.codexQuotaReport({ secondary: { utilization: 0.5, windowMinutes: 45 } }) === "45m 50%");
	check("nothing read reports nothing", meter.codexQuotaReport(undefined) === undefined && meter.codexQuotaReport({}) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
