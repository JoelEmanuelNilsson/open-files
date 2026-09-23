# Facts — the 12-cell gauge in zen-chrome's bottom rule

Every number here has the command that printed it. `derived` = a command made
it. `said` = a session's understanding, not proved.

## The gauge as it stands

**derived** — the gauge is 12 cells wide.
```
rg -n "BAR_CELLS" pi/kit/extensions/zen-chrome/index.ts
# 74: const BAR_CELLS = 12;
```
With its ` 31.4%` label it costs 18 columns of the bottom rule.

**derived** — glyphs and alarm thresholds.
```
rg -n 'FILLED_CELL|EMPTY_CELL|level:' pi/kit/extensions/zen-chrome/chrome.ts
# 247: const FILLED_CELL = "█";
# 248: const EMPTY_CELL  = "⣿";
# 269: level: percent > 90 ? "critical" : percent > 70 ? "warning" : "normal"
```

**derived** — the gauge is the last label standing as the pane narrows. The
drop order is timer, then tasks, then squeeze the branch, then the gauge.
```
rg -n "Drop order" -A3 pi/kit/extensions/zen-chrome/chrome.ts
```

**derived** — the code states the gauge's purpose in its own doc comment:
"it is the only thing on screen that says compaction is coming."
```
rg -n "only thing on screen" pi/kit/extensions/zen-chrome/chrome.ts
```

## Why that purpose is dead

**derived** — compaction is switched off in settings.
```
jq -r '.compaction' ~/.pi/agent/settings.json
# { "enabled": false }
```

**derived** — the context window of the default model is 1,000,000 tokens.
```
jq -r '.defaultModel' ~/.pi/agent/settings.json          # claude-opus-5
# There is no ~/.pi/agent/models.json: pi ships the catalog itself.
jq '."anthropic-messages"["claude-opus-5"].contextWindow' \
  "$(npm root -g)"/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json
# 1000000
```

**said** — Joel never runs a session above 350,000 tokens.

**derived from the two above** — 350,000 / 1,000,000 = 35%. The gauge's
warning threshold is 70% and its critical threshold is 90%. So in this
config the gauge cannot reach either colour, cannot fill past 4 of its 12
cells, and is warning of an event that is disabled.

## The resource that does bind

**derived** — Anthropic returns unified rate-limit headers on every Claude
OAuth response. Live probe, 2026-09-02 22:33 BST:
```
TOK=$(jq -r '.anthropic.access' ~/.pi/agent/auth.json)
curl -s -D /tmp/hdr.txt -o /dev/null -X POST https://api.anthropic.com/v1/messages \
  -H "authorization: Bearer $TOK" -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: oauth-2025-04-20,claude-code-20250219" \
  -H "content-type: application/json" -H "user-agent: claude-cli/2.0.1 (external, cli)" \
  -H "x-app: cli" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,
       "system":[{"type":"text","text":"You are Claude Code, Anthropic'"'"'s official CLI for Claude."}],
       "messages":[{"role":"user","content":"hi"}]}'
rg -i "ratelimit" /tmp/hdr.txt
```
Result:
```
anthropic-ratelimit-unified-status: allowed
anthropic-ratelimit-unified-5h-status: allowed
anthropic-ratelimit-unified-5h-reset: 1788391200
anthropic-ratelimit-unified-5h-utilization: 0.66
anthropic-ratelimit-unified-7d-status: allowed
anthropic-ratelimit-unified-7d-reset: 1788397200
anthropic-ratelimit-unified-7d-utilization: 0.66
anthropic-ratelimit-unified-representative-claim: five_hour
anthropic-ratelimit-unified-fallback-percentage: 0.5
anthropic-ratelimit-unified-fallback: available
anthropic-ratelimit-unified-overage-status: rejected
```

**derived** — second probe two minutes later, same command: 5h utilization
0.66 → **0.67**, 7d unchanged at 0.66. The two windows are independent, and
the 5h number moves under ordinary work.

**said, from that movement** — utilization is a fraction of 1, not a
percentage of 100. One hundredth of the window in two minutes of coding puts
the window's whole budget at roughly three and a half hours of steady work,
which matches a limit people actually hit. On a 0–100 reading it would take
weeks to exhaust, which no one reports. `fallback-percentage: 0.5` agrees:
Claude Code drops Opus at 50% of the weekly claim, so 0.5 means a half.
Worth one calibration read against Claude Code's own `/usage` before this
ships.

**derived** — the clock, computed from the reset header at 22:35:34 BST.
```
node -e 'const r5=1788391200*1000, now=Date.now(), win=5*3600*1000;
const s=r5-win;
console.log("window", new Date(s).toLocaleString("en-GB"), "→", new Date(r5).toLocaleString("en-GB"));
console.log("elapsed", ((now-s)/win*100).toFixed(1)+"%");'
# window 02/09/2026, 20:20:00 → 03/09/2026, 01:20:00
# elapsed 45.2%
```

**derived from the two above** — at 22:35 the 5-hour window was **45% elapsed
and 67% spent**. Spend divided by time is 1.48. Holding that rate, the budget
empties at about 23:42 — roughly 1 hour 38 minutes before the window refills
at 01:20.

## What the harness can already see

**derived** — the kit already reads OAuth response headers.
```
rg -n "after_provider_response" -A4 pi/kit/extensions/wire.ts
# 366: pi.on("after_provider_response", (event, ctx) => {
# 367:   if (anthropicRequest(ctx)?.oauth !== true) return;
# 368:   const requestId = event.headers["request-id"];
```
So the rate-limit headers arrive at a hook this harness already handles.
Nothing new goes on the wire; the cost is zero extra requests.

**derived** — pi documents the hook as carrying status and headers.
```
sed -n '705,740p' "$(npm root -g)/@earendil-works/pi-coding-agent/docs/extensions.md"
```

**derived** — background agents are already tracked with a status each.
```
rg -n "AgentTaskStatus =|toolUses|liveCount" \
  pi/kit/extensions/agent-dock/agent-task-registry.ts
# 19: export type AgentTaskStatus = "queued" | "running" | "completed" | "failed";
# 35: readonly toolUses: number | undefined;
# 176: public liveCount(): number
```

**derived** — that count is already on screen as text, let into the bottom
rule's middle slot.
```
rg -n "task" pi/kit/lib/agent-task-count.ts
# 26: return `${tasks} ${tasks === 1 ? "task" : "tasks"} ↓`;
```

## Absent

- No rate-limit header is captured or stored anywhere in the kit today.
  `rg -n "ratelimit" pi/kit` returns nothing.
- No history of utilization over time exists, so a trend line would have to
  be built from scratch. A single reading is free; a sparkline is not.
- Agents report no progress, only start and settle. `toolUses` is the only
  in-flight number, and pi-subagents publishes it on settle.
