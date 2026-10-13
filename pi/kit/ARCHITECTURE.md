# pi-kit architecture

The rules the kit's code keeps. Paths are relative to `pi/kit/`. Where a test
enforces a rule, it is named; a change that breaks the rule fails it.

## 1. `extensions/` holds pi entry points only

An entry is `extensions/<name>.ts` (one file) or `extensions/<name>/index.ts`
(with private modules beside it). Nothing else in `extensions/` is loaded by pi.

pi loads each entry in its own jiti registry, in Node `readdirSync` order, which
libuv sorts by `strcmp` with files and directories interleaved. Two facts follow:

- **An entry's name is its place in the load order.** Turning `x.ts` into
  `x/index.ts` keeps its place only if no sibling name starts with `x` plus a
  byte below `.` — in practice, `x-`. Several behaviours hang on that order:
  agent-dock's scope is the first `session_shutdown` handler, wire's
  `before_provider_request` runs last, and each `registerTool` appends to the
  tool list the wire carries (the engine's five tools, then transcript's
  re-registered built-ins in `FACTORIES` order).
  `test/kit/load-order.test.mjs` pins them.
- **A module imported by two entries exists twice**, with its module state
  duplicated, because each entry has its own registry.

## 2. A file in `extensions/<name>/` is private

Only files in the same folder import it; tests are the exception.
`test/kit/import-boundaries.test.mjs` enforces this.

## 3. `lib/<domain>/` is shared code and the cross-extension contracts

A module lives in `lib/` when two or more entry points (extensions or `bin/`
tools) use it, or when it is a contract between extensions: `processShared()`
keys, event channels, message types, tool names. `lib` never imports from
`extensions/`, and every kit module a `lib` module imports is itself in `lib`.
`test/kit/import-boundaries.test.mjs` enforces this.

## 4. Cross-extension and cross-session contracts are frozen

Key and stored shape stay byte-identical: `processShared()` keys, the turn
clock, notices, the workflow sandbox's globals, bus channel names and payloads,
persisted `customType`s and entry shapes. Another copy of the kit, an older
session file or a running seat reads them. Change a shape by adding a new key.

## 5. Names

A file name is a 2–4 word domain name (`agent-wait-board.ts`, not
`board.ts`); no bare-role names like `utils`, `types` or `helpers`. `index.ts`
is used only as a pi entry, and there are no barrel files. Exempt: extension
entry names, which pi and the human see.

## 6. Tests

A test is `test/<domain>/<concept>.test.mjs`; shared fakes and harnesses are in
`test/support/`, and preview scripts that draw real rows are in `test/preview/`.
`test/suite-runner.mjs` discovers every `*.test.mjs`. The allowed domains are
listed in `test/kit/suite-layout.test.mjs`.

## 7. Docs

The top [`README.md`](README.md) holds the layout, these rules (by link) and an
index. Each feature's doc sits beside its code: `extensions/<name>/README.md`
or `lib/<domain>/README.md`.

## 8. What the model sees is pinned

These change only on purpose, never as a side effect of moving code: `skills/`
directories and each `SKILL.md`'s frontmatter, `../AGENTS.md`,
`../APPEND_SYSTEM.md`, tool names, descriptions and schemas, tool registration
order, the bodies of `agents/*.md`, every runtime string the model reads
unprompted, the owned prompt text, and every input to a persisted hash. A skill
body changes to keep a path in it true.

## 9. Behaviour includes when things happen

When env is read is behaviour: some variables are read at module load, others
in the factory (`PI_CHAT`, `PI_TRANSCRIPT`, `PI_ZEN_WAVE`), and moving a read between the two changes which seats
see which value. So is the order of registrations inside a factory.

Module-level code — env reads, `globalThis` or `processShared()` access, timers,
registrations at import, caches — stays loaded by the same set of entries.
Moving it into a module another entry also loads duplicates it (rule 1). Pure
functions and types move freely.

No new module-level state. State that must survive a re-import goes through
`lib/process/process-shared-state.ts`. A module-level container or `let` in a
session file stands only with `// shared-state: <why>` on the line above it
(`test/kit/shared-state.test.mjs`), and a raw timer outside the session scope
only with `// raw-timer: <why>` (`test/kit/source-invariants.test.mjs`).
