#!/usr/bin/env node
/**
 * ping-economics — what the keep-warm pings in the wire traces cost, and when
 * a ping stops paying for itself.
 *
 * Reads every trace in the wire-trace directory (`lib/wire-trace.ts`) and
 * prints, for the window those traces cover:
 *   seats       main seats (`inputs.parts.seat` starting "main") against the
 *               rest: subagents, and scripts run with `pi -p`
 *   trailing    pings a seat sent after its last request, whose refreshed
 *               cache no request of that seat ever read
 *   expired     `break` records with verdict "expired": a request that found
 *               its entry gone and rewrote `shortfall` tokens
 *   resumed     seats with a second `inputs` record, i.e. a later run of the
 *               same session
 *   break-even  per model, (write − read) / read pings: a ping costs the prefix
 *               at the read price, an expiry costs it at the write price
 *               instead of the read the next request pays anyway. Minutes at
 *               4:30 (headless) and 4:40 (main), the cadences
 *               `extensions/session-mode.ts` pings at.
 *
 * Prices come from pi's installed model table
 * (`@earendil-works/pi-ai/providers/all`), for the model named by the `inputs`
 * record in force at each request. A model the table does not know is named
 * and left unpriced; no price is ever guessed.
 *
 * Usage: node ping-economics.mjs [trace-dir]
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const DIR = process.argv[2] ?? join(homedir(), ".local/state/pi-kit/wire-trace");
const HEADLESS_GAP_MIN = 4.5;
const MAIN_GAP_MIN = 4 + 40 / 60;
const MTOK = 1e6;

// Anthropic's own listing first: other providers re-list the same ids, at the
// same price today, but the seat bought them from Anthropic.
const priceTable = new Map();
for (const provider of ["anthropic", ...getBuiltinProviders().filter((p) => p !== "anthropic")]) {
	for (const model of getBuiltinModels(provider)) {
		if (!priceTable.has(model.id)) priceTable.set(model.id, model.cost);
	}
}

function readTrace(path) {
	const records = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A torn last line from a seat that was writing when this ran.
		}
	}
	return records;
}

function emptyTally() {
	return { seats: 0, resumed: 0, trailingPings: 0, trailingCost: 0, expired: 0, expiredTokens: 0, expiredCost: 0, expiredExcess: 0 };
}

const tally = { main: emptyTally(), other: emptyTally() };
const unpriced = new Map();
const modelsSeen = new Set();
let firstAt = Number.POSITIVE_INFINITY;
let lastAt = 0;

for (const name of readdirSync(DIR)) {
	if (!name.endsWith(".jsonl")) continue;
	const records = readTrace(join(DIR, name));
	const inputs = records.filter((r) => r.t === "inputs").sort((a, b) => a.n - b.n);
	if (inputs.length === 0) continue;
	for (const r of records) {
		const at = Date.parse(r.at);
		if (at < firstAt) firstAt = at;
		if (at > lastAt) lastAt = at;
	}
	const t = String(inputs[0].parts?.seat).startsWith("main") ? tally.main : tally.other;
	t.seats++;
	if (inputs.length > 1) t.resumed++;

	/** The price of the model the `inputs` record in force at request `n` names. */
	const priceAt = (n) => {
		const model = inputs.findLast((r) => r.n <= n)?.parts?.model ?? inputs[0].parts?.model;
		modelsSeen.add(model);
		const cost = priceTable.get(model);
		if (cost === undefined) unpriced.set(model, (unpriced.get(model) ?? 0) + 1);
		return cost;
	};

	const lastRequest = Math.max(0, ...records.filter((r) => r.t === "req").map((r) => r.n));
	for (const ping of records.filter((r) => r.t === "ping" && r.n === lastRequest)) {
		t.trailingPings++;
		const cost = priceAt(ping.n);
		if (cost) t.trailingCost += ((ping.read ?? 0) * cost.cacheRead + (ping.write ?? 0) * cost.cacheWrite) / MTOK;
	}
	for (const brk of records.filter((r) => r.t === "break" && r.verdict === "expired")) {
		t.expired++;
		t.expiredTokens += brk.shortfall ?? 0;
		const cost = priceAt(brk.n);
		if (!cost) continue;
		t.expiredCost += ((brk.shortfall ?? 0) * cost.cacheWrite) / MTOK;
		t.expiredExcess += ((brk.shortfall ?? 0) * (cost.cacheWrite - cost.cacheRead)) / MTOK;
	}
}

const usd = (x) => `$${x.toFixed(2)}`;
const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

console.log(`traces ${DIR}`);
console.log(`window ${day(firstAt)} .. ${day(lastAt)} UTC`);
console.log("");
console.log("                         main   non-main");
const row = (label, pick) => console.log(`${label.padEnd(22)} ${String(pick(tally.main)).padStart(6)} ${String(pick(tally.other)).padStart(10)}`);
row("seats", (t) => t.seats);
row("resumed seats", (t) => t.resumed);
row("pings after last req", (t) => t.trailingPings);
row("  their cost", (t) => usd(t.trailingCost));
row("expired breaks", (t) => t.expired);
row("  tokens rewritten", (t) => t.expiredTokens);
row("  rewrite cost", (t) => usd(t.expiredCost));
row("  cost over a read", (t) => usd(t.expiredExcess));
console.log("");
console.log("break-even, per model seen: (write - read) / read pings");
for (const model of [...modelsSeen].sort()) {
	const cost = priceTable.get(model);
	if (!cost) continue;
	const pings = (cost.cacheWrite - cost.cacheRead) / cost.cacheRead;
	console.log(
		`  ${model.padEnd(20)} read $${cost.cacheRead}/MTok write $${cost.cacheWrite}/MTok  ${pings.toFixed(1)} pings = ` +
			`${Math.round(pings * HEADLESS_GAP_MIN)} min at 4:30, ${Math.round(pings * MAIN_GAP_MIN)} min at 4:40`,
	);
}
for (const [model, count] of unpriced) console.log(`unpriced: ${model} is not in pi's model table (${count} records left out of the costs)`);
