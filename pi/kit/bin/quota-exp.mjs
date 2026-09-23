#!/usr/bin/env node
// Controlled quota-weight experiment. Raw fetch, no pi, no agents.
//
//   node pi/kit/bin/quota-exp.mjs read  [--model M] [--prefix 150000] [--n 100]
//   node pi/kit/bin/quota-exp.mjs out   [--model M] [--n 30] [--max 8000]
//   node pi/kit/bin/quota-exp.mjs write [--model M] [--prefix 20000] [--n 50] [--ttl 5m|1h]
//   node pi/kit/bin/quota-exp.mjs probe [--model M]        one tiny request, print quota
//
// Each mode isolates one bucket:
//   read  – one cache write, then N pings of the same prefix, aborted at message_start
//   out   – tiny prefix, N long generations (output tokens only)
//   write – N distinct prefixes, each written once, aborted at message_start
// Every request logs usage + the raw 5h/7d utilization headers to a jsonl file.

import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? dflt : args[i + 1];
};
const model = opt("model", "claude-fable-5-1");
const n = Number(opt("n", mode === "read" ? 100 : mode === "out" ? 30 : 50));
const prefixTokens = Number(opt("prefix", mode === "read" ? 150000 : 20000));
const maxTokens = Number(opt("max", 8000));
const ttl = opt("ttl", "5m");
const log = opt("log", `/tmp/quota-exp-${mode}-${Date.now()}.jsonl`);

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8")).anthropic;
if (auth.expires < Date.now()) throw new Error("OAuth token expired — open pi once to refresh");

const HEADERS = {
	authorization: `Bearer ${auth.access}`,
	"anthropic-version": "2023-06-01",
	"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
	"user-agent": "claude-cli/2.1.260",
	"x-app": "cli",
	"content-type": "application/json",
	accept: "application/json",
};

// Filler: real prose/code from the vendored Effect repo (random words trip the
// refusal classifier, and a refusal writes no cache). ~2 chars/token for code.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const CORPUS = `${process.env.HOME}/.agents/repos/effect`;
function* walk(dir) {
	for (const name of readdirSync(dir).sort()) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p);
		else if (/\.(md|ts)$/.test(name) && st.size > 2000) yield p;
	}
}
const FILES = [];
for (const f of walk(CORPUS)) {
	FILES.push(f);
	if (FILES.length > 4000) break;
}
function filler(tokens, seed) {
	const chars = tokens * 2;
	const parts = [];
	let total = 0;
	let i = seed % FILES.length;
	while (total < chars) {
		const text = readFileSync(FILES[i], "utf8");
		parts.push(`### ${FILES[i]} (set ${seed})\n${text}`);
		total += text.length;
		i = (i + 1) % FILES.length;
	}
	return parts.join("\n\n").slice(0, chars);
}

function body(system, user, max, cache) {
	const cc = cache ? { cache_control: { type: "ephemeral", ...(ttl === "1h" ? { ttl: "1h" } : {}) } } : {};
	return {
		model,
		max_tokens: max,
		stream: true,
		system: [
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text: system, ...cc },
		],
		messages: [{ role: "user", content: [{ type: "text", text: user, ...cc }] }],
	};
}

// One request. `stopAtStart` aborts once message_start has arrived (the ping shape).
async function send(payload, stopAtStart) {
	const controller = new AbortController();
	const t0 = Date.now();
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify(payload),
		signal: controller.signal,
	});
	const q = {
		h5: res.headers.get("anthropic-ratelimit-unified-5h-utilization"),
		d7: res.headers.get("anthropic-ratelimit-unified-7d-utilization"),
		reset5: res.headers.get("anthropic-ratelimit-unified-5h-reset"),
	};
	if (!res.ok) {
		const text = await res.text();
		return { ok: false, status: res.status, text: text.slice(0, 400), q, ms: Date.now() - t0 };
	}
	const usage = {};
	let outputChars = 0;
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				const chunk = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				const line = chunk.split("\n").find((l) => l.startsWith("data:"));
				if (!line) continue;
				const ev = JSON.parse(line.slice(5));
				if (ev.type === "message_start") {
					const u = ev.message.usage;
					usage.input = u.input_tokens;
					usage.read = u.cache_read_input_tokens ?? 0;
					usage.write = u.cache_creation_input_tokens ?? 0;
					usage.served = ev.message.model;
					if (stopAtStart) {
						controller.abort();
						return { ok: true, ...usage, output: 0, aborted: true, q, ms: Date.now() - t0 };
					}
				} else if (ev.type === "content_block_delta" && ev.delta?.text) {
					outputChars += ev.delta.text.length;
				} else if (ev.type === "message_delta") {
					usage.output = ev.usage?.output_tokens ?? 0;
				} else if (ev.type === "error") {
					return { ok: false, status: 0, text: JSON.stringify(ev).slice(0, 400), q, ms: Date.now() - t0 };
				}
			}
		}
	} catch (e) {
		if (!controller.signal.aborted) throw e;
	}
	return { ok: true, ...usage, outputChars, q, ms: Date.now() - t0 };
}

function record(i, r) {
	const line = { at: new Date().toISOString(), mode, model, i, ...r };
	appendFileSync(log, `${JSON.stringify(line)}\n`);
	const s = r.ok
		? `#${i} in=${r.input} read=${r.read} write=${r.write} out=${r.output ?? "?"} 5h=${r.q.h5} 7d=${r.q.d7} ${r.ms}ms`
		: `#${i} FAIL ${r.status} ${r.text} 5h=${r.q.h5}`;
	console.log(s);
	return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	console.log(`mode=${mode} model=${model} n=${n} prefix=${prefixTokens} log=${log}`);
	const totals = { read: 0, write: 0, output: 0, input: 0 };
	const add = (r) => {
		if (!r.ok) return;
		totals.read += r.read;
		totals.write += r.write;
		totals.output += r.output ?? 0;
		totals.input += r.input;
	};
	if (mode === "probe") {
		record(0, await send(body("probe", "Reply with the single word: ok", 5, false), false));
		return;
	}
	if (mode === "read") {
		const sys = filler(prefixTokens, 42);
		const payload = body(sys, "Reply with the single word: ok", 5, true);
		// Warm the cache once (full response, so the write completes and is confirmed).
		add(record(0, await send(payload, false)));
		for (let i = 1; i <= n; i++) {
			const r = record(i, await send(payload, true));
			add(r);
			if (!r.ok && r.status === 429) {
				await sleep(20000);
				continue;
			}
			if (r.ok && r.read < prefixTokens * 0.9) console.log("  !! cache miss — prefix was not read from cache");
		}
	} else if (mode === "out") {
		const sys = filler(500, 7);
		for (let i = 1; i <= n; i++) {
			const user = `Write a long, detailed, original essay of at least ${Math.round(maxTokens * 0.7)} words about topic number ${i}: the history of a fictional city. Do not stop early. No headings, prose only.`;
			const r = record(i, await send(body(sys, user, maxTokens, false), false));
			add(r);
			if (!r.ok && r.status === 429) await sleep(20000);
		}
	} else if (mode === "write") {
		for (let i = 1; i <= n; i++) {
			const sys = filler(prefixTokens, 1000 + i);
			const r = record(i, await send(body(sys, "Reply with the single word: ok", 5, true), true));
			add(r);
			if (!r.ok && r.status === 429) await sleep(20000);
		}
	} else {
		throw new Error(`unknown mode ${mode}`);
	}
	console.log("totals", JSON.stringify(totals));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
