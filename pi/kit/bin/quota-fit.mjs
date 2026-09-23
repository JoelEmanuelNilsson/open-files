#!/usr/bin/env node
/**
 * quota-fit — what does one token cost, in 5-hour-window utilization?
 *
 * The wire trace (`lib/wire-trace.ts`) files a `use` record per answered
 * request: token counts (`input`, `read`, `write`, `write1h`, `reasoning`)
 * paired by `n` with the `req` record that names the `model`, plus the
 * subscription meter Anthropic returned on that same response
 * (`quota.fiveHourUtilization`, rounded to 0.01).
 *
 * One reading is useless: a 0.01 step is the whole resolution. The signal is
 * cumulative. Within a single 5-hour window (constant `fiveHourResetAtSec`)
 * utilization is a running total, so
 *
 *     utilization(t) = base(window) + sum_over_categories w_c * cumulative_c(t)
 *
 * and the w_c fall out of a non-negative least-squares fit. A reset zeroes the
 * total, so windows are fitted with their own intercept and never spliced.
 *
 * Categories, per model:
 *   in     uncached input tokens
 *   read   cache-read tokens
 *   w5m    cache-write tokens with 5-minute retention (`write - write1h`)
 *   w1h    cache-write tokens with 1-hour retention (`write1h`)
 *   think  reasoning tokens (the only output-side count the trace records —
 *          there is no plain output-token field, so visible output is
 *          unmeasurable here and its cost lands wherever it correlates)
 *
 * Usage: node quota-fit.mjs [trace-dir] [--json]
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.argv[2]?.startsWith("--")
	? join(homedir(), ".local/state/pi-kit/wire-trace")
	: (process.argv[2] ?? join(homedir(), ".local/state/pi-kit/wire-trace"));
const AS_JSON = process.argv.includes("--json");

const CATS = ["in", "read", "w5m", "w1h", "think"];

// ---- load ------------------------------------------------------------------

/** Merge `use` records with the `model` from their paired `req`, across all sessions. */
function loadRecords(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const text = readFileSync(join(dir, name), "utf8");
		if (!text.includes('"quota"')) continue;
		const reqs = new Map();
		for (const line of text.split("\n")) {
			if (!line) continue;
			let r;
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			if (r.t === "req") reqs.set(r.n, r);
			else if (r.t === "use" && r.quota) {
				const req = reqs.get(r.n);
				const write = r.write ?? 0;
				const w1h = r.write1h ?? 0;
				out.push({
					session: name,
					at: r.at,
					ms: Date.parse(r.at),
					model: req?.model ?? "unknown",
					ttlMin: req?.ttlMin,
					in: r.input ?? 0,
					read: r.read ?? 0,
					// write1h is a *slice* of write, not a sibling: verified w1h <= write
					// in every record, and equal to it whenever nonzero.
					w5m: Math.max(0, write - w1h),
					w1h,
					think: r.reasoning ?? 0,
					u5: r.quota.fiveHourUtilization,
					u7: r.quota.sevenDayUtilization,
					reset5: r.quota.fiveHourResetAtSec,
					reset7: r.quota.sevenDayResetAtSec,
				});
			}
		}
	}
	out.sort((a, b) => a.ms - b.ms);
	return out;
}

// ---- linear algebra --------------------------------------------------------

/** Solve the normal equations A'A x = A'b by Gaussian elimination with a ridge nudge. */
function solveLeastSquares(A, b, ridge = 0) {
	const n = A[0].length;
	const M = Array.from({ length: n }, () => new Float64Array(n + 1));
	for (let i = 0; i < A.length; i++) {
		const row = A[i];
		for (let j = 0; j < n; j++) {
			if (row[j] === 0) continue;
			for (let k = j; k < n; k++) M[j][k] += row[j] * row[k];
			M[j][n] += row[j] * b[i];
		}
	}
	for (let j = 0; j < n; j++) {
		for (let k = 0; k < j; k++) M[j][k] = M[k][j];
		M[j][j] += ridge;
	}
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-14) continue;
		[M[c], M[p]] = [M[p], M[c]];
		const pv = M[c][c];
		for (let k = c; k <= n; k++) M[c][k] /= pv;
		for (let r = 0; r < n; r++) {
			if (r === c || M[r][c] === 0) continue;
			const f = M[r][c];
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return Array.from({ length: n }, (_, j) => M[j][n] || 0);
}

/**
 * Non-negative least squares (Lawson-Hanson), with `free` naming columns that
 * may go negative — the per-window intercepts, which are offsets not costs.
 */
function nnls(A, b, free = new Set(), maxIter = 300) {
	const n = A[0].length;
	const x = new Float64Array(n);
	const P = new Set(free);
	for (let iter = 0; iter < maxIter; iter++) {
		// gradient of 0.5||Ax-b||^2 w.r.t. x, negated
		const w = new Float64Array(n);
		for (let i = 0; i < A.length; i++) {
			let r = -b[i];
			for (let j = 0; j < n; j++) r += A[i][j] * x[j];
			for (let j = 0; j < n; j++) if (A[i][j] !== 0) w[j] -= A[i][j] * r;
		}
		let best = -1;
		let bestW = 1e-12;
		for (let j = 0; j < n; j++) if (!P.has(j) && w[j] > bestW) ((bestW = w[j]), (best = j));
		if (best < 0) break;
		P.add(best);
		for (let inner = 0; inner < 60; inner++) {
			const cols = [...P].sort((a, c) => a - c);
			const sub = A.map((row) => cols.map((j) => row[j]));
			const s = solveLeastSquares(sub, b, 1e-12);
			let alpha = 1;
			let blocking = -1;
			for (let k = 0; k < cols.length; k++) {
				const j = cols[k];
				if (free.has(j) || s[k] > 0) continue;
				const denom = x[j] - s[k];
				const a = denom <= 0 ? 0 : x[j] / denom;
				if (a < alpha) ((alpha = a), (blocking = j));
			}
			if (blocking < 0) {
				x.fill(0);
				for (const j of free) if (!P.has(j)) x[j] = 0;
				for (let k = 0; k < cols.length; k++) x[cols[k]] = s[k];
				break;
			}
			const old = Float64Array.from(x);
			x.fill(0);
			for (let k = 0; k < cols.length; k++) x[cols[k]] = old[cols[k]] + alpha * (s[k] - old[cols[k]]);
			for (const j of [...P]) if (!free.has(j) && x[j] <= 1e-15) ((x[j] = 0), P.delete(j));
		}
	}
	return Array.from(x);
}

// ---- design ----------------------------------------------------------------

/** Split records into runs of constant `reset5`; a reset zeroes the meter. */
function windows(recs) {
	const by = new Map();
	for (const r of recs) {
		if (!by.has(r.reset5)) by.set(r.reset5, []);
		by.get(r.reset5).push(r);
	}
	return [...by.entries()].map(([reset, rows]) => ({ reset: Number(reset), rows })).sort((a, b) => a.reset - b.reset);
}

/**
 * Cumulative design matrix. `columns` names the fitted parameters: one per
 * (model, category) pair that carries tokens, plus one intercept per window.
 */
function buildDesign(wins, models) {
	const columns = [];
	for (const m of models) for (const c of CATS) columns.push(`${m}|${c}`);
	const nTok = columns.length;
	for (const w of wins) columns.push(`base@${w.reset}`);
	const index = new Map(columns.map((c, i) => [c, i]));
	const A = [];
	const b = [];
	const meta = [];
	wins.forEach((w, wi) => {
		const cum = new Float64Array(nTok);
		for (const r of w.rows) {
			for (const c of CATS) {
				const j = index.get(`${r.model}|${c}`);
				if (j !== undefined) cum[j] += r[c];
			}
			const row = new Float64Array(columns.length);
			row.set(cum);
			row[nTok + wi] = 1;
			A.push(Array.from(row));
			b.push(r.u5);
			meta.push(r);
		}
	});
	return { A, b, columns, meta, nTok, freeCols: new Set(columns.map((_, i) => i).filter((i) => i >= nTok)) };
}

function fitStats(A, b, x) {
	let ss = 0;
	let n = 0;
	const mean = b.reduce((s, v) => s + v, 0) / b.length;
	let tot = 0;
	for (let i = 0; i < A.length; i++) {
		let p = 0;
		for (let j = 0; j < x.length; j++) p += A[i][j] * x[j];
		ss += (p - b[i]) ** 2;
		tot += (b[i] - mean) ** 2;
		n++;
	}
	return { rmse: Math.sqrt(ss / n), r2: 1 - ss / tot, n };
}

// ---- report ----------------------------------------------------------------

const recs = loadRecords(DIR);
if (recs.length === 0) {
	console.error(`no quota-bearing records under ${DIR}`);
	process.exit(1);
}
const wins = windows(recs);
const modelTotals = new Map();
for (const r of recs) {
	const t = modelTotals.get(r.model) ?? { n: 0, ...Object.fromEntries(CATS.map((c) => [c, 0])) };
	t.n++;
	for (const c of CATS) t[c] += r[c];
	modelTotals.set(r.model, t);
}
const models = [...modelTotals.keys()].sort((a, b) => modelTotals.get(b).n - modelTotals.get(a).n);

const { A, b, columns, nTok, freeCols } = buildDesign(wins, models);
const x = nnls(A, b, freeCols);
const stats = fitStats(A, b, x);

// Per-million weights, keyed model -> category.
const perM = {};
for (const m of models) {
	perM[m] = {};
	for (const c of CATS) perM[m][c] = x[columns.indexOf(`${m}|${c}`)] * 1e6;
}

// Robust check 1: whole-window slope. Total utilization gained across a window
// divided by total tokens, per category share — a sanity envelope, not a fit.
const windowSummary = wins.map((w) => {
	const first = w.rows[0];
	const last = w.rows[w.rows.length - 1];
	const tok = Object.fromEntries(CATS.map((c) => [c, 0]));
	const byModel = new Map();
	for (const r of w.rows) {
		for (const c of CATS) tok[c] += r[c];
		byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.in + r.read + r.w5m + r.w1h);
	}
	const total = CATS.reduce((s, c) => s + tok[c], 0);
	const share = [...byModel.entries()].sort((a, c) => c[1] - a[1]).map(([m, v]) => `${m} ${((100 * v) / total).toFixed(0)}%`);
	return {
		reset: w.reset,
		resetAt: new Date(w.reset * 1000).toISOString(),
		n: w.rows.length,
		from: first.at,
		to: last.at,
		uFrom: first.u5,
		uMax: Math.max(...w.rows.map((r) => r.u5)),
		du: Math.max(...w.rows.map((r) => r.u5)) - first.u5,
		tok,
		total,
		perMread: tok.read === 0 ? null : ((Math.max(...w.rows.map((r) => r.u5)) - first.u5) * 1e6) / tok.read,
		mix: share,
	};
});

// Robust check 2: do pings move the meter? A ping is a tiny-input, cache-read-only
// request with no reasoning. Compare utilization steps that follow a ping against
// steps that follow real work, per 1M read tokens.
const isPing = (r) => r.in < 50 && r.read > 1000 && r.think === 0 && r.w5m + r.w1h < 500;
const pings = recs.filter(isPing);
const pingRuns = [];
for (const w of wins) {
	let run = null;
	for (const r of w.rows) {
		if (isPing(r)) {
			if (!run) run = { u0: r.u5, read: 0, n: 0, uLast: r.u5 };
			run.read += r.read;
			run.n++;
			run.uLast = r.u5;
		} else if (run) {
			pingRuns.push(run);
			run = null;
		}
	}
	if (run) pingRuns.push(run);
}
const pingReadTotal = pingRuns.reduce((s, r) => s + r.read, 0);
const pingDu = pingRuns.reduce((s, r) => s + (r.uLast - r.u0), 0);

// Tier: extrapolate a full window from the best-covered window.
const bestWin = windowSummary.reduce((a, w) => (w.du > a.du ? w : a));
const tierTokens = bestWin.du > 0 ? bestWin.total / bestWin.du : null;

// Cost of one 150k-context request, per model, using the fitted weights.
// A steady-state turn on a warm cache: ~150k read, a few hundred input, a
// modest write, ~1-2k reasoning.
const shape = { in: 200, read: 150_000, w5m: 0, w1h: 2_000, think: 1_500 };
const requestCost = {};
for (const m of models) {
	let u = 0;
	for (const c of CATS) u += (perM[m][c] / 1e6) * shape[c];
	requestCost[m] = u;
}

const out = {
	dir: DIR,
	records: recs.length,
	sessions: new Set(recs.map((r) => r.session)).size,
	span: [recs[0].at, recs[recs.length - 1].at],
	models: Object.fromEntries(models.map((m) => [m, modelTotals.get(m)])),
	fit: { ...stats, perMillion: perM, intercepts: Object.fromEntries(wins.map((w, i) => [w.reset, x[nTok + i]])) },
	windows: windowSummary,
	pings: { count: pings.length, runs: pingRuns.length, readTokens: pingReadTotal, utilizationGained: pingDu },
	tier: { window: bestWin.reset, tokensPerFullWindow: tierTokens },
	requestCost: { shape, utilization: requestCost },
};

if (AS_JSON) {
	console.log(JSON.stringify(out, null, 2));
	process.exit(0);
}

const pct = (v) => (v * 100).toFixed(2) + "%";
const k = (v) => (v / 1000).toFixed(0) + "k";
console.log(`quota-fit — ${recs.length} metered requests, ${out.sessions} sessions, ${recs[0].at} .. ${recs[recs.length - 1].at}`);
console.log(`fit: n=${stats.n}  R²=${stats.r2.toFixed(4)}  rmse=${stats.rmse.toFixed(4)} utilization\n`);
console.log("utilization per 1M tokens, by model and kind (NNLS, per-window intercept):");
console.log(["model".padEnd(18), ...CATS.map((c) => c.padStart(9)), "reqs".padStart(6), "readTok".padStart(9)].join(" "));
for (const m of models) {
	const t = modelTotals.get(m);
	console.log(
		[m.padEnd(18), ...CATS.map((c) => perM[m][c].toFixed(4).padStart(9)), String(t.n).padStart(6), k(t.read).padStart(9)].join(" "),
	);
}
console.log("\nwindows (a reset zeroes the meter; each fitted with its own base):");
for (const w of windowSummary) {
	console.log(
		`  reset ${w.resetAt}  n=${String(w.n).padStart(4)}  u ${w.uFrom.toFixed(2)}→${w.uMax.toFixed(2)} (Δ${w.du.toFixed(2)})  ` +
			`tokens ${k(w.total).padStart(7)}  read ${k(w.tok.read).padStart(7)}  ` +
			`u/1M-read ${w.perMread === null ? "—" : w.perMread.toFixed(3)}  [${w.mix.join(", ")}]`,
	);
}
console.log(
	`\npings: ${pings.length} ping-shaped requests in ${pingRuns.length} runs, ${k(pingReadTotal)} read tokens, ` +
		`utilization gained during those runs: ${pingDu.toFixed(2)}`,
);
console.log(`tier: best-covered window burned ${k(bestWin.total)} tokens for Δ${bestWin.du.toFixed(2)} → a full window ≈ ${tierTokens === null ? "?" : k(tierTokens)} mixed tokens`);
console.log("\none 150k-context request (200 in / 150k read / 2k write-1h / 1.5k reasoning):");
for (const m of models) console.log(`  ${m.padEnd(18)} ${pct(requestCost[m])} of a 5h window   → ${(1 / requestCost[m]).toFixed(0)} such requests per window`);
