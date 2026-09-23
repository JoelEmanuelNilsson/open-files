---
name: workflow-authoring
description: The Workflow script API — agent/pipeline/parallel/phase/log/args, schema-forced results, resume — with the gotchas and two worked scripts. Read before writing or editing a Workflow script.
---

# Workflow authoring reference

A workflow runs the same job on many things, or drives a system to green: a short JavaScript script starts one child per item, collects the answers, and returns them. The script is where the structure lives — what fans out, what runs after what — and only its return value comes back to you.

**One child per item, one pass. Check by running the tests, not by spawning reviewers. Add a second pass only when Joel asks.**

The right move is usually **hybrid**: scout inline first (list the files, find the modules, scope the diff) to discover the work-list, then call Workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*. For larger work, run several workflows in sequence across turns — read each result before deciding the next phase.

What an item is:

- One item = one thing one worker finishes with a clear check. If it is bigger, split it in the script — never ask a child to fan out.
- `type: 'explore'` for find/read/report items; `type: 'worker'` (default) for a bounded change; `lead` is refused.
- A child may start explorers; it may not start a workflow.

## The script

Pass the script inline via `script` — do not Write it to a file first. Every invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with `{scriptPath: "<path>"}` instead of resending the full script.

Every script must begin with `export const meta = {...}`:

```js
export const meta = {
  name: 'fix-flaky-tests',
  description: 'Fix each flaky test in its own child',        // one line, shown in the dock
  phases: [                                                  // one entry per phase() call
    { title: 'Scan', detail: 'find retry markers in the test logs' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body starts here — use agent()/parallel()/pipeline()/phase()/log()
phase('Scan')
const flaky = await agent('Read the CI logs at .ci/logs/*.txt and list every test that was retried.', {schema: FLAKY_SCHEMA})
...
```

The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `whenToUse`, `phases`. Use the SAME phase titles in `meta.phases` as in `phase()` calls — titles are matched exactly; a `phase()` call with no matching meta entry just gets its own progress group. Add `model` to a phase entry when that phase uses a specific model override.

Scripts are plain JavaScript, NOT TypeScript — type annotations (`: string[]`), interfaces, and generics fail to parse. The script body runs in an async context — use `await` directly. Standard JS built-ins (JSON, Math, Array, etc.) are available — EXCEPT the clock and the RNG, which throw (they would break resume): `Date.now()`, `Date()`, argless `new Date()`, `Math.random()`, `Temporal.Now` (bar its `timeZoneId()`), and an `Intl.DateTimeFormat` `format()` with no date. A date from explicit arguments is fine. Pass timestamps in via `args`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. `setTimeout`/`clearTimeout` work, and are cleared when the run ends; `console.log`/`info`/`warn`/`error`/`debug` write to the run's log, an object as its JSON. `Atomics`, `FinalizationRegistry`, `SharedArrayBuffer`, `WeakRef` and `WebAssembly` are absent: they call back on the host's or the GC's schedule. Local time and the default locale are the host's, so pass a `timeZone` and a locale to anything that formats a date. No filesystem or Node.js API access, no `eval`/`new Function`, no `import()` — the word `import` is refused anywhere outside a string or a comment, so write a property of that name as `obj['import']`. Every shell command, file read and test run lives inside an `agent()` call. The 30 s timeout covers only the script's synchronous start: a loop that never awaits after that freezes your seat, so every loop awaits an `agent()` or a timer.

## Script body hooks

- `agent(prompt: string, opts?: {label?, phase?, schema?, model?, thinking?, type?, isolation?: 'worktree', stallMs?}): Promise<any>` — spawn a child. Without `schema`, returns its final text as a string. With `schema` (a JSON Schema with `type: 'object'` at its root — anything else stops the run), the child is forced to call a `StructuredOutput` tool and `agent()` returns the validated object — no parsing needed. Returns `null` if the child dies on a terminal error, is stopped mid-run, or never fits its schema (filter with `.filter(Boolean)`). `opts.label` is the child's name in the dock and `ListAgents`. `opts.phase` explicitly assigns this agent to a progress group (use this inside `pipeline()`/`parallel()` stages to avoid races on the global `phase()` state — same phase string → same group). `opts.model` (`opus` | `luna`) overrides the model for this call. Default to omitting it — the child inherits your model, which is almost always correct; `luna` for routine, repetitive work and read-only search only, never judgment. `opts.thinking` (`low` | `medium` | `high` | `xhigh` | `max`) overrides the reasoning effort — omit for the type's level; anything else throws. A level the model lacks is clamped to the nearest one it has. `opts.isolation: 'worktree'` runs the child in its own git worktree on branch `agent/<name>` — EXPENSIVE (~200–500 ms setup + disk per agent), use ONLY when agents must edit the same files concurrently; the worktree is removed if unchanged, the branch never deleted, and you merge it. `opts.type` uses an agent type from `~/.pi/agent/agents/` (e.g. `'explore'`) instead of the default worker — the same registry as the `Agent` tool; composes with `schema`. `opts.stallMs` (default 180000) stops a child that makes no progress — no streamed token, no tool call, no turn ending — for that long while none of its tool calls is running (a long test run is work, not a stall), and starts it again fresh with the same prompt; after 3 attempts it returns `null` like a dead child. Same-prefix siblings (same model, thinking, type, schema-or-not) spawn staggered behind the first for up to 5 s, so one pays the prompt-cache write and the rest read it — automatic, nothing to set.
- `pipeline(items, stage1, stage2, ...): Promise<any[]>` — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives `(prevResult, originalItem, index)` — use `originalItem`/`index` in later stages to label work without threading context through stage 1's return value. A stage that throws or returns `null` — a dead child's `null` included — ends that item: it is `null` and its remaining stages are skipped, so no stage ever receives `null`. A `null` item runs no stage.
- `parallel(thunks: Array<() => Promise<any>>): Promise<any[]>` — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent dies) resolves to `null` in the result array — the call itself never rejects, so `.filter(Boolean)` before using the results. Use ONLY when you genuinely need all results together.
- `log(message: string): void` — a progress line for Joel (a notification, and the `/workflows` tree).
- `phase(title: string): void` — start a new phase; subsequent `agent()` calls are grouped under this title in the progress display.
- `args: any` — the value passed as Workflow's `args` input (`undefined` if not provided). A string that parses as a JSON object or array is parsed back into that value before the script runs, so `args.filter`/`args.map` work whichever way the call was written; every other value arrives verbatim. Use this to parameterize saved workflows — a target path, a list of files, a config object — instead of a side-channel file.

What you `return` is written whole to `<sessionDir>/workflows/<runId>/result.json`, always. It must be something JSON can write: a cycle, a `bigint` inside an object, a getter that throws or a function (`return pipeline` rather than its result) stops the run with that reason. Under 8 000 chars it also arrives whole in your conversation. Over that, what arrives is a head: the file's path, the value's shape (every top-level key with its type and size), and the first 2 000 chars — read the rest with the `jq` the head spells out, rather than asking for the value again. So return the shape you will query: a few named keys beat one giant array, and a per-item detail that only `jq` will ever read costs you nothing.

Children start with **zero conversation context**. Every prompt must be self-contained: paths, definitions, what "the diff" means. This is the #1 way workflows fail — a prompt that only makes sense to someone who read this conversation. Each child reads this above your prompt:

> Your final assistant message IS the return value of a function call in a program. It is not a message to a human. Return raw data — no preamble, no summary of what you did, no markdown pleasantries, no offers to help further.
>
> You have no access to the conversation that created this task. Everything you need is in the prompt below. If something is genuinely missing, say so in your return value rather than guessing at the surrounding context.

Siblings share the machine. A child that writes a scratch file at a fixed path (`/tmp/failures.jsonl`) collides with its siblings and returns another item's answer in a perfectly valid shape — no schema catches it (ticket 37: 2 of 20 Sonnet children). Say in the prompt: use `jq`/pipes in one command, or a scratch path that carries the item (`/tmp/<file>.failures.jsonl`).

For structured output, use the `schema` option — validation happens at the tool-call layer, so the child retries against the validator's own errors (three attempts; after the third failure that `agent()` returns `null` and the run goes on, the failure named with the validator's last errors — your schema or prompt is wrong). The schema must have `type: 'object'` at its root; wrap a list as `{ type: 'object', properties: { items: … } }`.

## Failures

| Event | Result |
|---|---|
| A child dies (terminal error, a usage limit) or is stopped | that `agent()` → `null`; the run is still valid |
| A child stalls (no progress for `stallMs`, no tool running) | started again fresh, 3 attempts in all; then `null`, as when a restart is refused |
| A thunk throws inside `parallel` | that slot → `null`; the barrier never rejects |
| A stage throws inside `pipeline` | that item → `null`, remaining stages skipped |
| A stage returns `null` (a dead child's included), or an item is `null` | that item → `null`, remaining stages skipped |
| A promise you never await or catch rejects | listed as a failure with its reason; the run goes on |
| Schema validation fails 3× | that `agent()` → `null`, reported with the validator's last errors; siblings keep their results |
| More than 1000 agents in one run | throw — runaway backstop |
| More than 4096 items in one `pipeline`/`parallel` call | throw — an explicit error, never silent truncation |
| Unknown `type` (or another spawn the engine refuses), a bug in the script | that call throws; catch it, or its thunk or stage is `null` |
| Unreadable `scriptPath` | the `Workflow` call is refused |

The caps, a non-object schema and a stop end the run the moment they are thrown. Catching one does not keep the run going: the run has already ended, and every hook called after that never settles, so the script stops where it is. A hook still pending when the script returns is dropped the same way.

None of the failures is silent: after your return value, the result the parent reads counts the agents (run, failed, skipped, cached) and lists each failed or skipped agent, dropped item, dropped task and promise left rejected with its reason, then the resume call. A `null` item you pass in, or a `null` your own stage returns, is yours and is not listed. Rate limits and overloads are retried inside the child before it counts as dead; a usage limit is not, and its line carries the provider's words — resume after it resets.

Concurrent `agent()` calls are capped at `min(16, available CPUs − 2)` per workflow — excess calls queue and run as slots free up. You can still pass 100 items to `parallel()`/`pipeline()` and they all complete; only ~10 run at any moment. If a workflow bounds coverage itself (top-N, a per-round cap), `log()` what was dropped — silent truncation reads as "covered everything" when it didn't.

## Default to pipeline

DEFAULT TO `pipeline()`. Only reach for a barrier (`parallel` between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N−1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 failures → skip the fixers entirely")
- Stage N's prompt references "the other results" for comparison
- Stage N cannot start until every item's edits have landed on disk (the next test run)

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: `pipeline(items, stageA, r => transform([r]).flat(), stageB)`
- "The stages are conceptually separate" — that's what `pipeline()` models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 children run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast ones' idle time.

Smell test: if you wrote
```js
const a = await parallel(...)
const b = transform(a)        // flatten, map, filter — no cross-item dependency
const c = await parallel(b.map(...))
```
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Two-stage pipeline — the same job on many modules, each module's tests running as soon as its migration lands:
```js
export const meta = {
  name: 'migrate-modules',
  description: 'Migrate each module, then run its tests',
  phases: [{ title: 'Migrate' }, { title: 'Test' }],
}
const CHANGE = { type: 'object', required: ['module', 'files', 'notes'], properties: { module: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }
const TESTS = { type: 'object', required: ['passed', 'output'], properties: { passed: { type: 'boolean' }, output: { type: 'string' } } }
const results = await pipeline(
  args.modules,                                    // scouted inline before the call: ['src/auth', 'src/billing', ...]
  (m) => agent(`Migrate ${m} from callbacks to async/await. Touch only files under ${m}/. Report every file you changed.`,
    { label: `migrate:${m}`, phase: 'Migrate', schema: CHANGE }),
  (change, m) => agent(`Run the tests for ${m} only: \`npm test -- ${m}\`. Do not edit anything. Report passed=true only if the command exited 0, and the output verbatim.`,
    { label: `test:${m}`, phase: 'Test', schema: TESTS }).then((t) => ({ ...change, tests: t })),
)
return { done: results.filter(Boolean).filter((r) => r.tests?.passed).map((r) => r.module), failed: results.filter(Boolean).filter((r) => !r.tests?.passed) }
// src/auth's tests run while src/billing is still migrating. No wasted wall-clock.
```

When a barrier IS correct — every fixer's edits must be on disk before the next check:
```js
const fixes = await parallel(files.map(([file, items]) => () => fix(round, file, items)))   // <-- genuinely needs ALL at once
last = await check(round + 1)
```

## Fix until the system is green

The system reports what to fix with clear pointers; children fix what it says; the loop reruns the checks until nothing fails. Four things in this script are load-bearing: every shell command lives in an agent (scripts have no shell); the round number is in every prompt, so each round's calls are told apart in the journal and in `/workflows`; the barrier is justified in a comment; and group-by-file is what makes concurrent fixers safe on a shared working tree — no worktrees, no merge step.

```js
export const meta = {
  name: 'fix-until-green',
  description: 'Run the project checks, fix each failing file in parallel, re-run — up to 3 rounds',
  whenToUse: 'When Joel wants tests and lint driven to green without supervising each fix',
  phases: [
    { title: 'Check', detail: 'run the check commands and parse failures' },
    { title: 'Fix',   detail: 'one agent per failing file' },
  ],
}

const MAX_ROUNDS  = 3
const MAX_FIXERS  = 12                       // per round; anything dropped gets logged, never silently cut
const CHECKS      = args?.checks ?? ['npm test', 'npm run lint']

const FAILURES_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'failures'],
  properties: {
    passed:   { type: 'boolean', description: 'true only if every command exited 0' },
    failures: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'line', 'check', 'message'],
        properties: {
          file:    { type: 'string',  description: 'repo-relative path' },
          line:    { type: 'integer' },
          check:   { type: 'string',  enum: ['test', 'lint'] },
          message: { type: 'string',  description: 'the assertion or rule text, verbatim' },
        },
      },
    },
    unparsed: { type: 'string', description: 'failure output you could not attribute to a file:line, verbatim' },
  },
}

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'fixed', 'summary'],
  properties: {
    file:    { type: 'string' },
    fixed:   { type: 'boolean', description: 'false if you could not fix it — say why in summary' },
    summary: { type: 'string' },
  },
}

// Scripts have no shell or filesystem access, so every command runs inside an agent.
// The round number is in the prompt on purpose: each round's check is its own call
// in the journal and in /workflows.
const check = (round) => agent(
  `Round ${round} of a fix-until-green loop. Working directory: the repository root.

Run these commands one at a time, in order, and let each finish:
${CHECKS.map(c => `  ${c}`).join('\n')}

Then report every failure. For each one give the repo-relative file path, the 1-indexed
line, whether it came from the test run or the lint run, and the assertion or rule text
verbatim. Do not fix anything, do not edit any file, and do not summarize — this output is
parsed by a program. Put any failure output you cannot attribute to a specific file:line
into "unparsed" rather than dropping it. Set passed=true only if every command exited 0.`,
  { label: `check:round-${round}`, phase: 'Check', schema: FAILURES_SCHEMA })

const fix = (round, file, items) => agent(
  `Round ${round}. Fix every failure in ${file}. Do not touch any other file — other agents
are editing theirs concurrently.

${items.map(f => `  ${file}:${f.line}  [${f.check}]  ${f.message}`).join('\n')}

Read the file, understand why each one fails, and fix the cause. Do not delete, skip, or
weaken a test to make it pass, and do not silence a lint rule with an inline disable unless
the rule is genuinely wrong here — if it is, say so in the summary. If you cannot fix one,
set fixed=false and explain; a partial honest result beats a broken file.`,
  { label: `fix:${file}`, phase: 'Fix', schema: FIX_SCHEMA })

let round = 0, last = null
const rounds = []

while (round < MAX_ROUNDS) {
  round++

  last = await check(round)
  if (!last) { log(`round ${round}: check agent returned nothing — stopping`); break }
  if (last.passed) { log(`round ${round}: all checks green`); break }
  if (last.unparsed) log(`round ${round}: unattributed failure output — ${last.unparsed.slice(0, 200)}`)

  // Group by file, then one agent per file. That is what makes the fixers safe to run
  // concurrently on a shared working tree — disjoint files, no worktree isolation needed
  // and no merge step. Two agents editing one file would clobber each other.
  const byFile = new Map()
  for (const f of last.failures) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }

  let files = [...byFile.entries()]
  if (files.length > MAX_FIXERS) {
    const dropped = files.slice(MAX_FIXERS).map(([f]) => f)
    log(`round ${round}: ${files.length} failing files, fixing ${MAX_FIXERS} this round — deferred: ${dropped.join(', ')}`)
    files = files.slice(0, MAX_FIXERS)
  }
  log(`round ${round}: ${last.failures.length} failures across ${files.length} files`)

  // A barrier is correct here, and it is the exception rather than the default: the next
  // check cannot run until every fix has landed on disk. pipeline() would start round N+1's
  // check while round N's fixes were still being written.
  const fixes = (await parallel(files.map(([file, items]) => () => fix(round, file, items)))).filter(Boolean)

  rounds.push({ round, failures: last.failures.length, files: files.length, fixes })

  const stuck = fixes.filter(f => !f.fixed)
  if (stuck.length === files.length) {
    log(`round ${round}: no file could be fixed — stopping early rather than burning another round`)
    break
  }
  if (stuck.length) log(`round ${round}: ${stuck.length} file(s) not fixed — ${stuck.map(f => f.file).join(', ')}`)
}

return {
  green: last?.passed === true,
  roundsRun: round,
  remainingFailures: last?.passed ? [] : (last?.failures ?? []),
  rounds,
}
```

## Resume

The tool result includes a `runId`. To resume after a stop, a kill, or a script edit, relaunch with `Workflow({scriptPath, resumeFromRunId})` — an unchanged `agent()` call returns its cached result instantly when it would start in the same world as before: every agent that had finished before it started last time has been replayed, and nothing has run live and finished yet. So the first edited or new call runs live, and so does every call that starts after it finishes; a call that started after a child died runs live too (it may have seen that child's partial work), while calls that started before still hit. Parallel siblings and pipeline stages that finished out of order hit whatever order they finished in. Same script + same args after a run with no failed child → 100% cache hit, and resuming a resumed run hits the same way; the result opens with `[resumed from <runId> — N cached]`. Same-session only; a prior run still going is stopped first; without `args`, the prior run's are used. Before diagnosing why a completed workflow returned an empty or unexpected result, Read `<sessionDir>/workflows/<runId>/journal.jsonl` — it records each agent's actual return value; do not assume cached results are non-empty. `null` is never cached: a child that died or never fit its schema writes a `failed` line, so resuming re-runs it. `Date.now()`/`Math.random()`/`new Date()` are unavailable in scripts (they would break this) — stamp results after the workflow returns, or pass timestamps via `args`.

Saved workflows live at `~/.pi/agent/workflows/<name>.js` and run by `Workflow({name, args})`; their scripts follow every rule above.
