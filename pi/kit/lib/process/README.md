# `lib/process/` — what one pi process shares

Paths are relative to `pi/kit/`.

pi loads each extension entry in its own module registry, so a module that two
entries import exists twice, and a module-level variable in it is two
variables. These three modules are where a fact goes when every copy, in every
seat of the process, must see the same one.

- `process-shared-state.ts` — `processShared(key, make)`: one container per
  key on `globalThis`, built on first use. Anything that must survive a
  re-import goes behind it; `test/kit/shared-state.test.mjs` flags module state
  that does not.
- `human-notice.ts` — the one route for a message to the human: this seat's UI,
  else the seat that owns the screen, else the private day log under the state
  dir. Also `noticeOnce` (once per process, not per seat) and `terminalWrite`,
  the only stream write the kit makes.
- `kit-state-dir.ts` — the kit's private state root, `$XDG_STATE_HOME/pi-kit`,
  its 0700 directories and age pruning.

## Keys other kit copies read

A worktree seat can run a second copy of the kit in the same process, so these
keys and the shape stored under them are a contract between copies: renaming
one, or changing its shape, breaks sharing with no test failing.

| key | module | stored |
|---|---|---|
| `__piKitScreenOwner` | `human-notice.ts` | the screen owner's notify function, replaced or deleted |
| `__piKitNoticeOnce` | `human-notice.ts` | a `Set` of once-keys, via `processShared` |

Two of the kit's keys sit on `globalThis` directly rather than behind
`processShared`: `__piKitScreenOwner` above, a slot that is deleted when its
owner leaves, and `__piTurnClock` (`lib/session/turn-clock.ts`), an immutable
value replaced on every advance. `processShared` builds a container once and
never replaces it, so it cannot hold either without changing the stored shape.
