# The status bar

SketchyBar, replacing the macOS menu bar rather than sitting under it.

One chip of the terminal's glass per group, floating on the desktop.

Fourteen items for **0.042% of one core** — 0.038 CPU-seconds over 90 seconds of
wall clock, summed across all fifteen processes, read from `proc_pid_rusage` at
nanosecond resolution. (`ps` will tell you 0.2%; that is a lifetime average and
is mostly process startup. `top` will tell you 1%; that is sampling noise on
numbers this small.)

## The idea

A status bar is mostly a lie about how computers work. It shows you ten numbers
as if they were ten separate facts that each need going and fetching, and the
conventional config believes that lie: one script per item, one `update_freq`
each, ten `fork`+`exec` per second, every one of them booting a framework to
ask a single question and then dying.

They are not ten facts. They are one machine.

So there is one resident process that knows the whole machine, and it says so
once a second.

```
bin/sysprobe ──── one line a second ────▶ bin/pump ──── one batched ────▶ the bar
   (resident)     plus a line the         (one loop)    sketchybar call
                  instant volume, the
                  audio device or the
                  keyboard changes
```

That is the entire polling budget: **one fork per second, for the whole bar.**
Everything else is push.

Nobody has published a CPU-versus-item-count measurement for SketchyBar — the
question is asked in the project's discussions and goes unanswered. So the
number above is the only one I know of, and the method is in this README so it
can be argued with.

| What | How it arrives | Cost at rest |
|---|---|---|
| workspaces, leader layer | `aerospace subscribe` | nothing |
| now playing | `media-control stream` | nothing |
| volume, mute, audio device | CoreAudio listeners inside `sysprobe` | nothing |
| keyboard backlight | CoreBrightness callback inside `sysprobe` | nothing |
| cpu, memory, battery, network, clock | the 1 Hz line | one fork/sec, shared |
| an agent finished talking | `sketchybar --trigger agent_done` | nothing |

One item uses SketchyBar's own clock, and only while it is lit: the agent light
re-arms its two-second burst every six seconds for as long as an agent is
waiting on you, and sets `update_freq=0` again on the way out. An idle bar polls
nothing.

## Why there is a compiled part

`bin/sysprobe.m` exists because two of these numbers cannot be got from a shell
at all.

**CPU load is a delta.** It is the ratio of busy ticks to total ticks *between
two readings*, so a command that starts, measures and exits has nothing to
compare against. Staying resident turns it into arithmetic.

**The keyboard backlight has no shell interface.** `ioreg`, `nvram`, `defaults`
and every Homebrew brightness tool come back empty; the level lives behind a
private class in CoreBrightness reached over XPC. It is also the only route
that can *watch* the level, so the F-keys and the ambient light sensor move the
icon on the bar exactly as a click does.

Everything else it does — battery, memory, audio, network — it does because it
is already running, and one process answering seven questions costs less than
one process answering one.

## The layout

The notch takes 185 points out of the middle, so there is no centre section.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│  󰊠 󰖟 󰌨   ♫ now playing   cpu   mem      notch   ♪ ☾  vol% dev wifi kbd   65%   22 Sep Tue 19:06    │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**One chip per group, and the bar draws nothing** (`skins/islands.sh`). Each
chip is filled with the same colour at the same opacity as Ghostty's window,
with a hairline of the foreground at 20% for an edge, corners at a third of
its height. The gaps between chips, and at both ends of the row, are the
desktop.

The chips have no blur, and cannot: sketchybar blurs whole windows — the bar,
a popup — and an item's background has no blur property. Blurring the bar
would frost the gaps as well. At 0.85 opacity the difference is small. The
power popup is its own window and is blurred.

The groups are the same under every skin: each is a bracket named
`chip.<group>`, and the skin's `CHROME_CHIP` and `CHROME_BORDER` decide what a
chip looks like. `skins/glass.sh` paints them transparent and makes the bar
itself one strip of glass, which is how the bar looked before islands.

How it got here: a chip per group read as scattered, then one chip per side,
one panel per side, then the strip. Islands came back with larger chips, an
edge on each, and fewer single-glyph chips (shazam and the appearance flip
share one).

**Left** is where you are and what the machine is doing. Three rooms, matching
`persistent-workspaces` in aerospace.toml; the active one's cell is filled, so
the row reads as one control with one member lit. Then what is playing, then the
two meters.

The meters and the title are here because they are the widest things on the bar
and this is where the width is. They used to be on the right, which meant ten
items crowded against one edge and seven hundred points of empty on the other —
not a layout, just a list that happened to be right-aligned.

**Right** is what you check rather than what you watch: the state of the
machine, and the time.

Two numbers are always on, the battery and the volume, and that is a reversal.
Both used to be silent until they mattered, on the theory that a bar full of
digits is a bar you stop reading. It is wrong about these two, where the
number *is* the answer — "am I about to run out" and "how loud is this" are
questions you ask *before* the thing goes wrong, and an icon with eleven states
can only answer them afterwards. The cpu and memory numbers are on too:
the sparklines carry the shape of the last
minute, but an idle cpu is a flat line at the bottom of a 16-point graph, and
a meter that never visibly moves reads as a decoration. A ticking number is
what live looks like.

Everything else stays icon-only. The audio device, the network and the keyboard
backlight are each one of a few states, and a glyph holds a state better than a
word does.

**Clicking the battery flips Low Power Mode.**

**The cable never drains the battery.** macOS's 80% Charge Limit comes with a
drain: plugged in above the limit, the machine runs off the battery until it
is back down to 80 (`chargeSocLimitDrain = 1` in `pmset -g battlimit`, with no
setting that turns it off). So the bar holds the limit at the charge instead.
At plug-in it picks the next step of the Settings slider — 80, 85, 90, 95,
100 — at or above the charge less one point, never below 80, and keeps that
limit until the cable comes out. Plugged in at 93, the limit is 95: the
battery gains at most two points and loses none. Below 80 the limit is 80 as
before. The hold is chosen once per plug-in and never recomputed from the live
charge, because powerd lets the charge settle a point over its limit and
recomputing from that would raise the limit a step at a time up to 100.

**The boost button charges to 100, once.** Whenever the cable is in, the
charge is below 100 and the hold is below 100, double chevrons dock onto the
battery chip's right edge in a filled cell of their own — the same cell
treatment as the active room, because two click targets in one chip need a
visible boundary. Press at any level, 2% included, and this one charge runs to
100. The boost ends at 100% or on unplug, whichever comes first; ending at
100% on the cable leaves the hold at 100, so the charge you asked for is not
drained back off. The chevrons disappear on the press and stay gone until
then; there is no cancel. On battery power the chevrons vanish and the chip
closes around the battery alone. `bin/pump` is the only thing that writes the
limit; the press only leaves a request for it in `/tmp/sketchybar-chargeboost`.

Apple ships no command for any of this — the native Charge Limit is enforced
by PowerUIAgent (root), which caches its settings for life, ignores SIGTERM,
and sits behind a SIP wall that blocks `launchctl kickstart`. What works,
measured on this machine, is write-kill-knock: rewrite one integer in its
plist, SIGKILL it, then knock on its XPC service so launchd respawns it now
rather than whenever demand next arrives — on an idle machine that is minutes,
with the new limit sitting unread the whole time. The knock is
`bin/wake-powerui`; the agent rejects the connection, which is fine, because
by then it is up and has re-registered the limit with powerd. Held at 80,
charging current went 0 → ~5000 mA within a minute of the click. Every write
restarts the agent, so pump reads the registered limit once at startup and
writes only when the limit it wants differs. A write sudo refuses — the rule
not installed yet, usually — is retried a minute later, so running
`install.sh` takes effect without replugging.

`pmset` needs root to change this and no privilege to read it, so the click goes
through one sudoers rule naming four exact command lines — no wildcard on the
flag, no wildcard on the value. The boost button gets a second rule of the same
shape: the five plist writes (80, 85, 90, 95, 100) and the kill, exactly, so
neither rule can be widened into a general root grant. `install.sh` writes
both, after `visudo -c` checks them, because a syntax error under
`/etc/sudoers.d` breaks `sudo` for everything and a status bar is a bad way to
find that out. Whether a rule is in place is read from `sudo -n -l`, which
lists the passwordless grants: the rule files are root-only, so a read test
is always false, and `sudo -l CMD` answers yes for any command to an admin.

## The agent light

When an agent finishes talking and is waiting on you, every chip on the bar
lights at once and the colour slides along it, left to right, for two seconds
straight — then the bar goes still, and does it again every six seconds until
you focus Ghostty.

Anything that can run one command can light it:

```bash
sketchybar --trigger agent_done
```

Two things do. `~/dotfiles/pi/kit/extensions/bar-light.ts` fires on pi's
`agent_settled`, and a `Stop` hook in `~/.claude/settings.json` fires on Claude
Code's. Neither knows anything about the bar beyond that line.

`./bin/test-agent-light` drives it by hand and traces one chip through a burst:

```
rooms   . . .
   d6dffb → adc0f8 → 84a1f5 → 6689f2 → 6b7ef2 → 8976f2 → 9f70f2 → bd69f2
 → db61f2 → f25dea → f263d4 → f26bb6 → f27298 → f27881 → …
 → f4f9b7 → f7facc → f9fcdb → fcfdef   . . . . . . . . . .
```

Sixty-eight steps, no two the same — which is the thing worth checking, because
a stall reads as a glitch and this had one.

**Why not a desktop notification.** There is one, in `pi/kit/extensions/notify.ts`,
and under Ghostty it sends OSC 777 — which herdr intercepts and draws as its own
toast, inside the herdr window, which is the window you are not looking at. That
is not a routing bug to work around. A notification is an *event*: it is
delivered where the event happened and then it is gone. "An agent is waiting" is
a *state*, and a state wants a surface that is visible from wherever you are.
The bar is `sticky=on`, so it is on every AeroSpace workspace by construction.

**Why the whole bar.** The first version was a wave that crossed once in a
second and left one 20-point chip drifting. It read as nothing, for two reasons
that are both about how peripheral vision works: a single small object changing
hue is not something the edge of the eye reports, and a thing that happens once
is a thing you had to already be looking at.

**Why it is one continuous movement and not a flash.** The second version fired
three discrete bands with dark between them. Three flashes is three events, and
three events is three chances to be looking the wrong way. One movement that is
*still going* when you turn your head is one thing happening. Every chip is lit
for the whole three seconds; what moves is the colour.

**Why it stops.** A bar that moves all the time is a bar you stop seeing. It
used to repeat every six seconds until Ghostty came to the front; that was a
nag. Now it is one three-second burst per `agent_done`, and then rest.

**Chips, not glyphs.** Area. A chip is about 20×60 points of solid colour and a
glyph is a few dozen points of ink inside it, and the periphery integrates area.
The cost is that this leans on a skin decision — a chip's visible surface is its
fill — and the arc is a value ramp with no near-white or near-black in it, so
for the fifth of a second a chip is at full saturation its label has less
contrast than usual. Stated rather than solved; the alternative is a signal
nobody sees.

**What is deliberately not painted.** The three room cells, because
`lib/rooms.sh` owns them and repaints on every workspace change; two writers on
one property is a light that dies whenever you switch rooms. They sit *on top
of* the rooms bracket, which is painted, so the row still moves. The sparklines,
because `graph.color` snaps rather than animating — measured. The bar's own
background, because `--bar` takes no `--animate`.

**The colour is pi's.** The arc is the same one `pi/kit/extensions/zen-chrome`
paints running tool calls with — 225° through 500°, folded at both ends, which
is why it has no teal and no cyan. `lib/arc.sh` is twelve waypoints along it,
generated by `pi/kit/bin/arc-waypoints.mjs` from that module's own `arcColor()`,
in both appearances:

```bash
~/dotfiles/pi/kit/bin/arc-waypoints.mjs > lib/arc.sh
```

A table of hex typed in by hand would be a second definition of the arc, and
second definitions drift.

**The arc does not wrap, so the colour walks out along it and back.** Stepping
off the green end and round to the blue start is a hue jump, and a jump in the
middle of a slide is exactly what makes it read as a glitch. Position and its
mirror give the same colour, so there is no discontinuity anywhere.

**`ADVANCE` must be odd.** A chip holds one colour for a whole hop whenever two
consecutive positions land on a mirror pair, and `2·phase + (2k+1)·ADVANCE ≡ 0
(mod 22)` has solutions only when `ADVANCE` is even. Found as a 0.17s stall at
the top of the arc, then derived.

**Two items, both invisible, and the second is not a spare.** An item with
`updates=off` receives no script invocations at all, triggers included — which
is what makes the light free at rest, with no fork per app switch while nothing
is waiting. It also means `agent` cannot hear the event that lights it. So
`agent.wake` stays awake for that one event and nothing else.
`plugins/game-hide` keeps a hidden listener for the same reason.

**It does not light if you were already looking.** If Ghostty is the front app
you saw the turn end. `plugins/agent-light` checks with `lsappinfo` — two forks
of about six milliseconds, against two hundred for `osascript`, and no
accessibility permission — and drops the trigger.

**No state.** Every animation chain ends at the resting colour, so a burst
cleans up after itself and there is nothing to latch, count, or put out. A
second agent finishing mid-burst restarts the wash from the left.

**Nothing animates while agents are working.** That was offered and declined,
and it is the right call: a bar that moves whenever a machine is busy is a bar
that moves all day, and then the one motion that means something is lost in it.

## Files

| | |
|---|---|
| `sketchybarrc` | the bar, the defaults, and the four processes |
| `lib/geometry.sh` | what this machine is: screen, bar height, notch. Measured |
| `lib/skin.sh` | resolves the palette and the skin, and loads it |
| `skins/flat.sh` | bordered boxes, square corners. What end4 wears |
| `skins/islands.sh` | one glass chip per group on a bar that draws nothing. What cyberdream and cyberpurple wear |
| `skins/glass.sh` | one full-width strip of glass; the chips are transparent |
| `lib/rooms.sh` | which room is lit. Shared by the aerospace bridge and the appearance plugin |
| `lib/icons.sh` | glyphs, verified against the font's own cmap, sized and placed from the skin |
| `lib/ink.sh` | the ink in each glyph and where its centre falls, as fractions of the em. Generated |
| `lib/arc.sh` | the hue arc the chips walk, in both appearances. Generated from pi's own `arcColor()` |
| `bin/sysprobe.m` | the resident probe. Compiled by `install.sh` |
| `bin/pump` | probe lines in, one batched render out |
| `bin/bridge-aerospace` | rooms and the leader layer |
| `bin/bridge-media` | now playing, Spotify and Chrome alike |
| `bin/supervise` | exactly one of each, across reloads |
| `bin/wake-powerui.c` | the knock that respawns PowerUIAgent. Compiled by `install.sh` |
| `bin/measure-icons` | measures the ink in each glyph into `lib/ink.sh`. Dev tool |
| `plugins/agent-light` | the whole of the agent light: the rail, the burst, the latch |
| `bin/test-agent-light` | drives the light by hand and prints what the bar did. Dev tool |
| `bin/hide-menubar.c` | holds the menu bar at alpha 0. Compiled by `install.sh` |
| `items/` | what exists |
| `plugins/` | what clicking does |

## Things that will bite whoever edits this

**Nothing here holds a colour or a chosen size except a skin.** `lib/skin.sh`
resolves two things — the palette `bin/theme` generated for the current
appearance, and the skin the current theme names — and hands both to one file
under `skins/`. That file says which palette slot plays which part (the bar, a
chip's fill, its outline, a lit cell, text, a graph's trace) and every number
that was chosen rather than measured (spacing, chip height, corner radius,
type, the caps that stop a glyph escaping its chip). `lib/geometry.sh` keeps
only what the screen reports. The split is the point: a fact you get wrong by
guessing, a choice you get wrong by copying someone else's.

Roles rather than hex is what makes a theme free. A chip is "surface", never
`#14192f`, so a new palette dresses the bar with nobody writing a bar.

The roles exist because they did not for a while, and the bar drew no chips at
all for it. Commit `0172392` moved the palette into `bin/theme` and deleted
`lib/colors.sh` without rebinding `background.color` or
`background.border_color`, which left every chip at `border_width=1` and
`border_color=0x0` — a transparent border, with nothing to warn you. Four of
the six generated values were read by no one. A colour you never set is not a
default colour, it is an invisible one.

**A palette change is applied in place; a skin change needs `--reload`.** Chip
height, corner radius and border width are properties of an item, fixed when
the item is created, and `--default` reaches only items added after it — so a
new shape can only be had by building the bar again. `bin/theme` does that, and
only when the skin actually changed. It is survivable here solely because
`bin/supervise` claims its pidfile before sweeping; every config that launches
helpers straight from `sketchybarrc` leaks one set per reload.

**A shared function must not read a variable its callers merely happen to
set.** `lib/rooms.sh` expected `$SKETCHYBAR`. `bin/bridge-aerospace` sets it;
`plugins/appearance` calls the same binary `SB`. So every appearance flip ran
`"" --animate …` and lost the error down a `2>&1`. The bar looked right anyway,
because the bridge repaints on every workspace change — the wrong colour
survived exactly until you switched rooms. `rooms.sh` claims the path itself
now, and only stdout is silenced, because stdout is where sketchybar reports a
regex that matched nothing.

**Setting any `background.*` property turns `background.drawing` on.** A
clause's properties apply left to right, so `drawing` only sticks if it comes
last — and `--animate` turns it on regardless of order, because a colour cannot
be interpolated on a background that is not drawn, and it never puts the flag
back. Measured, all four cases, in `lib/rooms.sh`.

Two rules fall out. **Colour first, `background.drawing` last, same clause** —
then anything that only ever wants to be drawn is correct by construction. And
**a cell's lit/unlit state is its colour, never its drawing flag**: all three
rooms are drawn all the time and an unlit one is transparent. That second one
is not a workaround for the first. Toggling `drawing` cannot fade, so the
`--animate tanh` on the room row was always a pop with a fade bolted to the
side of it; fading to transparent is the thing that was wanted.

This is what a blanket repaint costs if you miss it. `plugins/appearance` used
to do `--set '/.*/' background.color=…` and switched on every background on the
bar — all three rooms lit at once, and all nine spacers grew a bordered chip,
so every gap became a box. Nothing warns you. The bar just looks like a layout
bug. It now names the chips and the graphs one group at a time and never
mentions a spacer.

**A lit glyph uses `icon.highlight`, not `icon.color`.** `plugins/appearance`
repaints every item's text with one blanket `--set '/.*/'` on each flip, so an
item that sets `icon.color` directly is correct until the next flip and wrong
after it. `highlight_color` is a second colour the item already carries and the
blanket never touches; `bin/bridge-aerospace` flips `icon.highlight` alongside
`background.drawing`, so the lit room and its inverted glyph cannot come apart.

**sketchybar matches item names with POSIX *basic* regular expressions.**
Anchors work, so do `\.` and `[0-9]` — alternation does not. `|` and `()` are
literal characters there, so `/^(cpu|mem)$/` asks for an item named exactly
that, finds nothing, prints `No match found` on **stdout**, and exits 0. One
pattern per `--set` clause is the only safe form.

**A bracket's background swallows its members' padding. A plain item's does
not.** This is the one rule behind every spacing bug this bar has had. A
bracket is drawn from its first member's left edge *minus that member's
padding*, to its last member's right edge *plus its padding* — so padding
meant to sit between two brackets ends up inside one of them and separates
nothing. A standalone item's background stops at its own content, so its
padding really is outside the box.

One setting, three different answers depending on what is next to what. The bar
ran for a while with gaps of 0, 6, 6 and 12 points between its chips, none of
them chosen, and it read as arbitrary because it was:

| left of the gap | right of the gap | gap you get |
|---|---|---|
| bracket | bracket | 0 — both ate their own padding |
| bracket | item | the item's `padding_left` only |
| item | item | both paddings, so double |

So gaps are not paid for out of item padding here. Every item's `padding_left`
and `padding_right` is 0, chips are held apart by explicit spacer items that
belong to no bracket and cannot be swallowed by one, and the space *inside* a
chip comes from icon and label padding, which brackets do not touch. `GAP_CHIP`
in lib/geometry.sh moves every gap on the bar at once.

**An item's background is exactly the item's width, and cannot be narrowed.**
`background.padding_left` and `background.padding_right` translate it; they do
not resize it. Measured: setting both to 4 moved the box 4 points right and
left its width unchanged. This is why the active room is a filled cell rather
than an underline — at 22pt glyphs in a 26pt chip there is no room for a rule
that is neither touching the chip's border nor sitting on the glyph's feet.

**Icon size is capped by the notch, but font size is not icon size.** 32 points
is the entire budget: the bar cannot be taller without overlapping windows, the
chip must fit the bar, the glyph must fit the chip.

Inside that, one font size does not give one icon size. Measured at 26pt, the
ink in these glyphs ran from 10.5 points tall (the keyboard) to 22.5 (the
battery) — a factor of two, from the same nominal size. Your eye measures the
mark on the screen, not the em box around it, so a row set at one size looks
arbitrary.

Correcting on height alone is also wrong. The ink *widths* were already even,
13 to 16 points across every glyph, so scaling the keyboard up by the 1.7× its
height wanted would have left it half again as wide as its neighbours. What
matches is optical size — `sqrt(width × height)` — normalised to 17.5.
`bin/measure-icons` renders each glyph from the TTF, measures its ink box, and
writes the width, the height and the ink's centre into `lib/ink.sh` as
fractions of the em. Those are facts about the font. The point size is not — it
depends on how tall the chip is, which is the skin's decision — so
`lib/icons.sh` does that arithmetic at load, from the skin's `ICON_TARGET` and
the two caps that stop ink escaping the box. One `awk` for all fifty, because
macOS ships bash 3.2 and has no floating point at all. Before: 39% spread.
After: 9%.

### Every glyph sits in a square

A glyph with nothing else in its item sits in a square, `BOX_HEIGHT` on a side,
and the glyph is in the middle of it.

Neither half of that is free. **sketchybar does not measure a glyph by its
advance.** It measures the ink's right edge, rounds it up, and drops the left
side bearing, so the box it gives an icon is about a point and a half wider
than the glyph on the right side only. A 20-point chip came out 23 wide — an
oval, not a circle — with the glyph 0.75pt left of the middle. That is three
device pixels of daylight on one side and none on the other, which is small,
and the first thing you see.

So neither number is left to sketchybar. `icon.width` states the cell, set once
in `--default` so no item can forget it, and `icon.padding_left` places the pen
by hand from the ink's own centre:

    pad = BOX_HEIGHT/2 - cx * pt

`lib/icons.sh` emits that as `PAD_<name>` beside `PT_<name>`, in the same `awk`
pass, and everything that swaps a glyph at runtime carries the padding with it
exactly as it already carried the size — `bin/pump`, `bin/bridge-media`,
`plugins/appearance`.

The limit is sketchybar's: it parses padding as a whole number of points and
throws the fraction away. So the placement rounds, and the residual is at most
half a point — one device pixel at 2x, which is the finest a glyph can be
placed here at all.

The caps live with the chip height for the same reason: they were constants in
`measure-icons`, measured against a 29-point chip, and a 20-point skin would
have inherited them in silence.

**The size has to live beside the glyph, because three items change their glyph
while the bar is running** — the audio device picks between seven, the battery
twelve, the volume five. A single `icon.font` on those items is correct for
whichever glyph happened to be showing when it was chosen and wrong for all the
rest: the built-in speaker was drawn at the size measured from the AirPods
glyph and overflowed its chip by 28%. `bin/pump` picks glyph and size in the
same function, `--doctor` fails if any `ICON_*` has no `PT_*`, and neither is
reachable without the other.

**`BOX_LIFT` has to move the contents too.** It shifts a chip's background up
off the window below, and nothing else — so lifting the chips left every glyph
centred on the *bar* while its box sat a point higher. Measured: all thirteen
items exactly 1.25pt below their own chip's centre. `sketchybarrc` applies the
same offset to `icon.y_offset` and `label.y_offset` so the two cannot drift.

**The bar's height is measured, not chosen.** `sysprobe screen` reports the
screen's safe-area top inset — 32pt here, the exact depth of the notch, and
exactly what macOS subtracts from `frame` to get `visibleFrame`. Guessing 38
from "the menu bar looks about 37 tall" left six points of bar hanging below
the notch with a seam across the whole display.

**`gaps.outer.top` in aerospace.toml is 0, and that is the only correct
value.** macOS already withholds the notch strip from every app, and AeroSpace
tiles inside what is left, so windows start below the bar before any gap is
applied. A top gap here is a second gap stacked on a reservation that already
exists: 38+4 produced 74 points of dead air above every window. `--doctor`
checks both numbers.

**macOS ships bash 3.2.** No associative arrays, no `printf '%(%H)T'`, and
`printf '\uF0AC'` prints the literal text. That is why `lib/icons.sh` holds
literal characters and why the clock is formatted in C.

**Reloading leaks processes if you let it.** `sketchybar --reload` re-runs
`sketchybarrc` without stopping anything the last run started. `bin/supervise`
claims a pidfile *before* it sweeps, and the order matters: sweeping first makes
the dying generation kill its own replacement, and two reloads then alternate
between a working bar and no bar at all.

**AirPods and the speakers report volume on different channels.** AirPods have
no main volume element; the speakers have no channel elements. Read one and you
show 0% forever on the other.

**Never match an audio device by name.** This machine calls its AirPods
`Joel’s AirPods Pro`, with a curly U+2019, and uses the same name for the input
and the output device. Match on the UID, classify on the transport type.

**The now-playing item rests on Apple's signed `/usr/bin/perl`.** MediaRemote
was locked against unentitled processes in macOS 15.4; `media-control` gets in
by loading it inside a binary Apple signs. If Apple ever hardens perl, that one
item goes dark and nothing else is affected.

## The menu bar is genuinely gone

Three separate mechanisms, and it takes all three.

**Auto-hide** (`_HIHideMenuBar`) gives the 32pt strip back to windows, so
AeroSpace can tile from the top of the screen. It hides nothing — the bar is
still there, and still slides back down when the pointer reaches the top edge.

**`topmost=on`** puts this bar at `kCGStatusWindowLevel`, above the system menu
bar rather than below it, so the Apple menu can never be clicked.

**`bin/hide-menubar`** is what stops the pixels. It holds SkyLight's menu bar
override alpha at zero and the WindowServer composites the bar at zero opacity:
it still exists, still reveals on hover, and never draws.

That third one is needed because the first two are not enough and this config
originally claimed otherwise. The claim was tested badly. Both
`CGWarpMouseCursorPosition` and synthetic `CGEventPost` mouse-moves put the
pointer at y=0 without triggering the reveal at all, so the test was measuring
nothing and reporting a pass. The honest test is the other way round: force the
menu bar permanently visible, then check the override kills it. It does —
brightness in the strip goes 255 → 0 the moment the helper starts, and back to
255 the moment it dies.

Three things the internet says about this that are wrong:

- `SLSSetMenuBarVisibilityOverrideOnDisplay(cid, display, true)` is quoted
  everywhere as the way to hide the menu bar. It is a *show*-override and it
  forces the bar visible. No value of it hides anything.
- `NSApplicationPresentationHideMenuBar` does not work from a background agent.
  Presentation options apply only to the *active* application, and a
  window-less process can never become active — `isActive` stays false even
  after `activate(ignoringOtherApps:)`.
- A one-shot tool cannot do it. The override is keyed to the connection that
  sent it, so it evaporates when the process exits. That is why the helper is
  resident, and it is also why nothing is written to disk: kill it and the menu
  bar is completely back.

**It is tied to the bar's life on purpose.** `bin/supervise` owns it, so the
menu bar returns whenever the status bar is not running. A LaunchAgent would
hold it hidden through a crash, and that is the wrong trade — it would leave a
machine with no menu bar and nothing in its place, which is not a tidy screen,
it is a screen you cannot use.

Two consequences worth knowing. **App menus are unreachable with the mouse** —
File → Export is keyboard-only now, and Raycast's `Search Menu Items` is the way
back, so give it a hotkey before you need it. And `topmost=on` also covers the
region system alerts use. Sleep, Restart and Shut Down are where they were:
click the apple at the far left.

## Turning it off

```sh
brew services stop sketchybar
defaults write NSGlobalDomain _HIHideMenuBar -bool false && killall SystemUIServer
```

The second line matters. Without it you have no bar and no menu bar.
