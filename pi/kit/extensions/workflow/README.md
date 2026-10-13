# `workflow` — one child per item, only the return value comes back

The `Workflow` tool: a background script of child agents, one child per item, only the return value
coming back. The description says when a workflow fits (the same job on many things; fix until the system is green)
(`extensions/workflow/workflow-tool-text.ts`); the script API lives in `skills/workflow-authoring/SKILL.md`.

A script is plain JavaScript opening with `export const meta = {...}`, read
as a pure literal (`extensions/workflow/workflow-meta.ts`: a tokenizer, no parser; a
variable, call, spread or interpolation is refused with the rule) before
anything runs. The body runs in a `node:vm` context
(`extensions/workflow/workflow-sandbox.ts`) holding `agent`, `pipeline`, `parallel`,
`phase`, `log`, `console`, `setTimeout`/`clearTimeout`, `args` and
ECMAScript's built-ins — no `process`, no `require`, no `eval` or
`new Function` (the context compiles no string), no `import()` (the word is
refused before the run). The script never holds a host object: its hooks
are made inside the context by a prelude that reaches the host through one
bridge in its closure, and every result, array, promise and error it gets
back is re-created there. The host never runs on the script's stack: a hook
call is queued and handed over a microtask later, so a script that calls a
hook at its stack limit overflows in its own realm, never half way through
host code. The clock and the RNG throw on every path to
them — `Date.now()`, `Date()`, argless `new Date()` however the constructor
is reached, `Math.random()`, `Temporal.Now` bar its `timeZoneId()`, an
`Intl.DateTimeFormat` `format()` with no date; a date from explicit
arguments is fine. The
built-ins that call back on the host's or the GC's schedule are deleted
before the script runs — `Atomics`, `FinalizationRegistry`,
`SharedArrayBuffer`, `WeakRef`, and `WebAssembly`, whose `Memory` hands out
a `SharedArrayBuffer` even with code generation off. The host's time zone
and default locale stay readable, so a resume on a host set otherwise may
take another branch, whose calls miss the journal and run again. A promise
the script leaves rejected is a failure of its run, not the seat's crash:
until the run settles, one process listener claims a rejection whose
promise descends from the context's `Object.prototype` and hands any other
back to Node's own handling. Out of reach: a promise the script re-parents
onto `null`, or behind a proxy whose `getPrototypeOf` trap throws; Node
handles its rejection as the seat's own. Isolation, not security: the author is our
own model. The limit, shared with Claude Code:
the 30 s timeout covers only the script's synchronous start, so a loop that
never awaits after that, or awaits only already-settled values, freezes the
seat; only a worker thread could stop it, and the script runs in-process.

`extensions/workflow/workflow-runtime.ts` owns the scheduler and the failure table. All
throttling is in `agent()` — a semaphore of `16` that hands a
freed slot straight to the next waiter, a lifetime cap of 1000, the journal
— so `pipeline` (each item through every stage on its own, no barrier) and
`parallel` (a barrier that never rejects) stay naive. A child that dies,
stalls or never fits its schema is `null`, and the run goes on; a throwing
stage or thunk is `null`; a stage that returns `null` ends its item, so a
dead child's `null` never reaches the next stage. A cap, a bad schema or a
stop ends the run the moment a hook throws it, decided
on the host's own error: a script that catches it cannot fold it into a dud
or keep going, and once a run has ended every hook it calls parks, never
settling; so does an `agent()` still queued for a slot. A spawn the engine
refuses, such as an unknown type, and a bug in the script are the script's
own errors, as in Claude Code: that `agent()` throws, and a thunk or stage
it was in is `null`.
More than 4096 items in one call is an error, never a truncation.

The journal (`extensions/workflow/workflow-journal.ts`) is one JSONL line per finished
`agent()`, in finish order, written before `agent()` returns: a result, or
a `failed` line for a child that died. A call's key is sha256 of the prompt
and the options that change what the child does (`label`/`phase`
excluded), but a key alone cannot serve it — a call may depend on a file an
earlier agent wrote, not on text. So a result line also records `after`,
how many lines the run had written when that agent started (as the
engine sent its first prompt, whatever held it back), and
`resumeFromRunId` serves a result only into the world it started in: the
first unused prior result with the key whose first `after` prior lines
have all been replayed, and only until an agent has run live and finished.
The first edited call runs live, and so does everything that starts after
it finishes; a death re-runs itself and every agent that started after it,
never those that started before; a pipeline whose stages finished out of
order replays whole; a hit is journalled again with its prior `after`
mapped onto the new run's lines, so a resumed run resumes too, and two calls
that never depended on each other replay in either order. A line with no `after`, from an older journal, is
never served. The result
opens with `[resumed from <runId> — N cached]`. Same-session only; a prior
run still going is stopped first; a resume that names no `args` runs on the
prior run's, so the resume call a result prints works as printed. Esc while
that prior run is still stopping cancels the resume: the prior run goes on
stopping, no new run starts, and the new run id's `run.json` says `stopped`.

`agent(prompt, {schema})` (`extensions/workflow/workflow-structured-output.ts`): the
child's prompt gets the schema and an instruction to call `StructuredOutput`
once, last. That tool is registered on every seat, goes on the wire only for a
workflow child, and refuses anywhere else; inside one it validates with typebox's `Value` against the
contract the parent declared on a process-wide seam before spawning (keyed
by parent session and child name, so no call can precede its contract). A
mismatch is an error tool result carrying the validator's messages — the
model retries in the same run; a turn that ends with no call is one attempt
too, and the child is resumed from its transcript with a nudge; the third
failure rejects the contract, and that `agent()` is `null` with the
validator's last errors on its `agent-failed` event.

The run is a registry entry of type `workflow` (`extensions/workflow/workflow-run-lifecycle.ts`),
spawning through the engine's runtime off `lib/agents/agent-runtime-seam.ts`; so
`ListAgents` lists it, `TaskOutput` waits on it, `TaskStop` and the dock
stop it through the stopper it registers under its task id (the engine's
`stop` falls back to that map for a record it has no session for), and a
parent's cascade reaches it because it is marked live under the seat. Its
children are records flagged `workflowChild`: the tail carries the in-workflow line,
the prompt carries the two-paragraph child contract, and the
result is marked read at settle — never delivered, never waking anyone —
so only the return value reaches the conversation, draining into the next
turn like any result (`wake: true` as on `Agent`; always on a headless
seat). `<sessionDir>/workflows/<runId>/` holds `script.js` (every
invocation, including `scriptPath` ones), `journal.jsonl` and `run.json`;
`~/.pi/agent/workflows/<name>.js` is a saved workflow. `/workflows` prints
the live tree.

A stalled child is started again. The watchdog stops a child that streams no
token, starts no tool call and ends no turn for `stallMs` (default 180 s), and
its clock stops while any of the child's tool calls is running: a test suite
or a build is work, and a tool that never returns is left to its own timeout
(bash has one). So a stall is a hung stream, and the remedy is a fresh start
with the same prompt: three attempts in all, each restart written to the run
log, and after the third the slot is `null` with `stalled on all 3 attempts
(no progress for Ns each)`.

Provider limits are pi's to retry, by its `retry` settings: an overload, a rate limit, a 5xx or a dropped connection is retried, so a child dies of one only after those. A quota or usage limit is excluded from that retry and ends
the child at once, with the provider's words as its error. The engine gets no
reset time as data — at most a provider's sentence, such as Codex's `Try again
in ~N min.` — so a run does not pause for a reset: the child's slot is `null`,
and the result names the failure in the provider's words and says to resume
after the reset.

The result the parent reads is the value — whole up to 8 000 chars, otherwise
its path, shape and first 2 000 chars — then `[agents: N run (F failed, S
skipped, U unfinished), C cached]` once any agent was called, then
`[failures: N]` with one line per failed or skipped agent, dropped pipeline
item, dropped parallel task and promise the script left rejected, the first
20 and a pointer to `run.json`'s `failures` for the rest; then, when
anything failed or the run did not complete, the `[resume]` call. A run that errors or is stopped carries the
same lines under its error. The run store (`lib/workflow/workflow-run-store.ts`) folds every
failure as it happens, and the result and `run.json` read it there.
