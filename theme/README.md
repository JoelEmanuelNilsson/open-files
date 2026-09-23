# The theme system

## The principle

**The terminal's 16 ANSI colours, set by Ghostty, are the single runtime source
of truth.** Everything rendered inside the terminal — pi, herdr, starship, nvim,
eza, fzf, git — references ANSI slots by index or name, never hex. Only Ghostty
theme files and the sketchybar colours are generated; nothing else is written
per theme, so a program that wants to follow the theme has nothing to install
and nothing to regenerate.

macOS appearance picks dark or light through Ghostty's
`theme = dark:current-dark,light:current-light`, and every ANSI consumer follows
automatically, live, without a reload.

## The slots

Lightness is OKLCH L. There are two hue families: the **paper**, whose hue comes
from `seed` and whose chroma is `tint`, and the **ink**, whose hue comes from
`text_seed` (default: `seed`) and whose chroma is `text_tint`. One seed with two
chromas is what makes a theme read as a family — navy surfaces with periwinkle
text. Two seeds are for a palette whose ink is not its paper's colour at all:
cardboard's paper is warm sand at hue 85 and its ink is cool slate at hue 197,
112° apart, which no choice of chroma fakes.

| slot | role | family | L dark | L light | default floor |
|---|---|---|---|---|---|
| bg | default background | paper | 0.24 | 0.95 | — |
| fg | default foreground | ink | 0.80 | 0.35 | ≥7:1 |
| 0 | surface: selected rows, panels | paper | 0.30 | 0.90 | — |
| 8 | dim text and borders | ink hue, `tint` chroma | 0.55 | 0.62 | ≥3:1 |
| 7 | muted text | ink | 0.68 | 0.50 | ≥5:1 |
| 15 | strong text | ink | 0.90 | 0.22 | — |
| 1–6 | 1 red 25°, 2 green 145°, 3 yellow 85°, 4 blue 265°, 5 magenta 325°, 6 cyan 205° | — | 0.78 | 0.52 | ≥4.5:1 |
| 9–14 | the same six hues, L ±`bright_delta` | — | | | |
| cursor | ink hue, `cursor_tint` chroma (default 0.12) | ink | 0.80 | 0.45 | |
| selection | paper | paper | 0.38 | 0.84 | |

Slot 8 is the only one taking from both families, because it is the only one
with two jobs. Its hue is the ink's, since a hairline is thin ink rather than a
pale surface; its chroma is `tint`, since at that lightness it is a rule far
more often than a paragraph. With one seed the question never arose and both
answers were the same colour.

Rules that hold by construction and are asserted in `gen.py`, then tested in
`test_gen.py`: the six accent hues are ≥45° apart; a bright slot never changes
hue from its base (bold must not change hue); gamut mapping reduces chroma only,
never clips channels, so a slot arrives at the lightness it asked for and the
contrast that depends on it.

### The floors are declared, not assumed

The four contrast floors above and the minimum OKLab distance between any two
accents (0.08) are **defaults**. A mode states its own under `[MODE.floors]`,
and whatever it states is asserted — a mode that says 2.69 and ships 2.4 fails
generation. Naming a tier that does not exist fails too, so a typo is an error
rather than a floor silently dropped.

**A floor is measured on the worse of `bg` and slot 0**, and on all twelve
accent slots. Both halves of that sentence were once narrower and both hid the
same kind of bug. Measuring on `bg` alone gave every number in the table its
best case: slot 0 is a fill a fifth of a perceptual step off the background,
and a terminal UI paints most of its text on panels, where each colour is
~20% worse than the theme promised. Checking slots 1–6 alone left the brights
— which programs reach for constantly — unmeasured in every theme here; the
light mode's sat at 1.94:1 on `bg` and 1.56:1 on a panel, below the floor it
declared for itself, and generation passed.

What no mode may declare its way past: 1.5:1, roughly where a colour stops
separating from its background at text size, and 0.02 in OKLab, about one
perceptual step, below which two accents are one colour with two names.

This replaced a single `contrast_scale` multiplier, which could not describe a
palette whose foreground is fine and whose accents are not. `bin/theme check`
prints what a mode declared, both ratios for every slot, and marks every text
slot whose worse ratio is under WCAG AA (4.5:1), so the cost of a quiet palette
is visible rather than enforced.

Used well, the declaration records a fact about a reference that cannot be
nudged away: end4's dark half is pale-on-pale, its six bases land 0.082 apart
and their brights 0.070, and no `bright_delta` fixes that because the room
above them is gone. It declares 0.07. Used badly, it is a way to make an
unreadable palette generate, which is what the light mode did.

## Light mode is one file

`theme/light.toml` **is** the `[light]` table of every setup in `setups/`,
merged in by `gen.load_setup_toml`. A setup that wants to differ writes its own
`[light]` keys and they override that file's one at a time — and slot by slot
for `[light.accents]`.

It works the same way for `theme/dark.toml`, which does not exist: there is no
dark mode every theme shares. It exists for light because there is one, and
because it had been forty lines copied into each of the three setups, which is
not a shared light mode but three that happen to agree — they had already
drifted from their own comments.

The current light mode is **after cardboard** ([ErikHilbert1/cardboard-theme]),
a desaturated warm-sand-and-slate palette. After, not a port, and the gap is
worth stating: cardboard is a desktop terminal's idle colourscheme, and this is
the palette every program in this terminal is read through.

It keeps the paper exactly (`#e5dfd3`), both hues — warm sand at 85, cool slate
at 197 — and the quiet, which now lives in the accent chroma (0.095 against a
normal theme's 0.11). It does not keep the ink's lightness or the accent hues:

- The reference's `#4a5353` holds 4.80:1 on slot 0 against a declared floor of
  7, so the ink is darker and only its hue is the reference's.
- Its six accents are one pair of sRGB bytes permuted across three channels —
  red is (hi,lo,lo), cyan is (lo,hi,hi) — which puts its green and its yellow
  37° apart. Two colours that close separate only by being saturated, and at
  4.5:1 that needs chroma 0.15, which is the one thing this theme is not. So
  the hues are `gen.py`'s own ≥45° spread.
- Its brights are *lighter* than its bases (`0xa3` over `0x89`), so on paper
  the emphasis colour was the one you could see least. Here they go toward the
  ink.

An earlier version shipped the reference's bytes exactly and declared its
floors down to accent 2.69 and distance 0.038 to get them past generation.
That is how a theme ends up unreadable with every test passing. The mode now
has no `[floors]` block, because it meets the defaults.

[ErikHilbert1/cardboard-theme]: https://github.com/ErikHilbert1/cardboard-theme

## Adding a theme

Add one file, `theme/setups/NAME.toml`:

```toml
seed = "#98a5dc"      # the hue the surface tiers are tinted with
text_seed = "#4a5353" # optional: the hue the text tiers are tinted with.
                      # Defaults to `seed`, which is most themes
tint = 0.018          # chroma of the surface tiers
text_tint = 0.035     # chroma of the text tiers
cursor_tint = 0.012   # optional: chroma of the cursor. Default 0.12, which is
                      # far above any text tier on purpose -- the cursor is the
                      # one saturated thing on a muted screen. Set it to
                      # `text_tint` for a cursor that is plain ink
accent_chroma = 0.09  # chroma of the six accent hues. Per mode as well: a mode
                      # that ships its own accents ships its own chroma with
                      # them, and the light mode is quieter than the dark
hue_pull = 0.5        # optional, 0..0.75: fold the accent hues toward the seed.
                      # Per mode too, for the same reason — a setup-wide value
                      # would bend a mode's accents to another mode's seed
skin = "flat"         # optional: the bar's shape, sketchybar/skins/<name>.sh.
                      # Theme-wide, never per mode -- a skin is a shape and
                      # macOS flipping to light does not change a shape.
                      # Applying a theme whose skin differs from the current
                      # one reloads sketchybar; every other change is in place.
opacity = 0.78        # optional: window background opacity, 1 = solid.
                      # The default for both modes; [dark] / [light] opacity
                      # overrides it, and the change is live -- see "Glass".
blur = 40             # optional: macOS background blur radius, 0 = off. Same
                      # rules, and only visible while opacity < 1.
wallpaper = "auto"    # optional: "auto" renders a gradient from the palette
                      # (theme/wallpaper.py) and sets the desktop on apply;
                      # a path sets that image; omit to leave the desktop alone.
                      # This one IS per mode -- set it under [dark] / [light]

[dark]
wallpaper = "end4-dark.jpg"   # per-mode override; relative paths are theme/wallpapers/
```

### Glass

`opacity` and `blur` do not travel with the colours. A file Ghostty loads as a
`theme` may only carry colour keys; every other key in it is dropped silently,
with no warning and no error. So `bin/theme` writes them to
`theme/gen/ghostty/glass`, which `ghostty/config` pulls in with
`config-file = ?themes/glass`. Blur must be an integer: Ghostty reads `40.0`
as 0.

**Glass is per mode, and it changes live.** Ghostty's own configuration docs
say changing `background-opacity` "requires restarting Ghostty completely".
That is wrong for this include, on 1.3.1 / macOS 26, and it was measured: with
a window running at 0.68, writing `background-opacity = 1.0` into
`theme/gen/ghostty/glass` and sending `pkill -USR2 -a -f
'/Ghostty.app/Contents/MacOS/ghostty$'` turned the live window opaque with no
restart. Do not re-derive the restart rule from the docs.

What there is no syntax for is a conditional: `theme` takes
`light:…,dark:…`, `background-opacity` does not
([ghostty-org/ghostty#3773](https://github.com/ghostty-org/ghostty/discussions/3773),
still open). So glass works exactly like the wallpaper:

- `opacity` / `blur` under `[dark]` or `[light]` is that mode's value; the
  top-level one is the default both modes fall back to.
- `bin/theme` writes the single value for the **current** appearance and
  reloads. `apply` does it, and so does `theme reload` — which is the path an
  appearance flip takes, and the reason a flip changes the glass at all.
- The write must happen before the SIGUSR2 in `reload_consumers`, or the
  window is reading the outgoing mode's file.
- A shipped theme's dark glass is at the top level of its setup (end4 0.78/30,
  cyberdream and cyberpurple 0.68/20). Light mode is `opacity = 1.0`,
  `blur = 0` in `theme/light.toml`: paper behind glass is unreadable — 0.68
  over a dark wallpaper drags bg `#e5dfd3` to about `#ab9f95` and costs a
  third of every contrast ratio.

If you do set glass on a theme: the blur radius is honoured (Ghostty 1.3.1,
macOS 26) — screenshots of one window at blur 0, 10, 30 and 80 show the
wallpaper going from sharp, to soft shapes, to colour only, to a pale haze.
Opacity decides whose colour wins; low opacity over heavy blur lets the
wallpaper's averaged colour through, which over a bright picture reads as grey
milk. Glass only looks like its reference when the wallpaper is the same colour
family as the theme — brown glass over a blue wallpaper is grey — which is why
a theme owns its wallpaper. 0.75–0.85 is the range where the wallpaper reads.

`hue_pull = 0` keeps the classic red/green/yellow/blue/magenta/cyan spread; in
practice ~0.15 is the most a full-spectrum set can be folded before two slots
stop reading as different colours. Generation fails if any two of slots 1-6 are
closer in OKLab than the mode's `accent_distance` floor, measured on the
shipped (gamut-clipped) colours.

To reproduce a specific reference palette instead of a spectrum, list the
accents as `[L, C, h]` under `[dark.accents]` / `[light.accents]` — slots 1–6,
and 9–14 when the brights are not a uniform lift off their bases. `hex` →
OKLCH → `hex` round-trips losslessly, so a measured reference colour ships as
exactly itself (`light.toml` does all twelve this way).

If the reference does not pass the floors, decide which yields. Either declare
the mode's real floors under `[MODE.floors]` and live with them — that is what
cardboard does, because quiet is the point of it — or run
`python3 theme/solve_accents.py NAME MODE`, which prints the nearest set to the
reference that passes. Use its output; nudging by hand does not converge
because clipping moves colours more than the numbers suggest.

Then `bin/theme apply NAME`. A setup may override any lightness in
`DEFAULT_LIGHTNESS` (gen.py) under a `[dark]` or `[light]` table; the contrast
assertions still apply, so a bad override fails at generation time. A setup
with no `[light]` table gets `theme/light.toml` whole.

## The CLI

```
bin/theme list         themes, current one marked
bin/theme current      theme=NAME (what the sketchybar label reads)
bin/theme apply NAME   generate + make current + reload
bin/theme next         next theme, wrapping
bin/theme check [NAME] contrast table for dark and light
bin/theme reload       re-apply for the current appearance (wallpaper, Ghostty, herdr, sketchybar)
```

There is no state file. The current theme is the `theme/gen/ghostty/current-dark`
symlink; `current` is a `readlink`. `theme/gen/` is gitignored — all of it is output.

## The reload chain

`apply` / `next` / `reload` write `theme/gen/ghostty/glass` for the current
appearance and then end in `reload_consumers`, which does three things:

1. `pkill -a -USR2 -f '/Ghostty.app/Contents/MacOS/ghostty$'` — Ghostty reloads its
   config on SIGUSR2 (verified on 1.3.1). Matched on the full executable path.
   `-a` is load-bearing: pkill excludes its own ancestors from the match list,
   and Ghostty is the ancestor of any shell this is typed in.
2. `herdr server reload-config` — ignored if herdr is not running.
3. runs `sketchybar/plugins/appearance` — the bar is recoloured in place.
   The six values written to `theme/gen/sketchybar/<mode>.sh` are mapped onto
   the bar's roles by the skin the theme names, `sketchybar/skins/<name>.sh`,
   loaded by `sketchybar/lib/skin.sh`. Under `flat` the bar is bg, a chip is
   slot 0 with a slot-8 border, a lit cell is slot 7 with its glyph inverted to
   bg, and everything else is fg; `pill` inverts that — a chip is filled with
   slot 7 and text is bg. Never `sketchybar --reload` for a colour: that kills
   every plugin and redraws the bar.

   The one exception is the `skin` key itself, written to
   `theme/gen/sketchybar/skin`. Chip height, corner radius and border width are
   fixed when an item is created, so a skin change cannot be applied in place
   and `apply` does reload — only when the name actually changed. Safe because
   `sketchybar/bin/supervise` claims its pidfile before sweeping. An appearance
   flip never changes the skin, so a flip never reloads.

`reload` (run by `plugins/appearance` on macOS's appearance notification, and
by aerospace at login) sets the wallpaper for the current appearance and then
does the same three. macOS posts the notification about twenty times per flip,
so `reload` is single-flight with coalescing: one worker holds
`theme/gen/reload.lock`, later callers touch `reload.pending` and exit, and the
worker loops while a mark exists. A flip that lands mid-run is applied once.

The mark alone is not enough, because macOS posts the notification *before*
`AppleInterfaceStyle` reads back as the new value: the entire burst can arrive
while the flag is still stale, so the first pass paints the outgoing mode's
wallpaper and then sees no reason to go round again. The worker therefore also
waits `APPEARANCE_SETTLE` and re-reads the flag, and repeats if it moved.
Within one pass the mode is read once and passed down, so nothing that depends
on it can disagree with anything else.

## Known limits

- **nvim runs without truecolor** (`termguicolors = false`), because from 0.10 on
  it otherwise paints its own hex default colorscheme and ignores the terminal
  palette. The cost is that nvim has exactly the 16 slots, like everything else
  here.
- **Ghostty is the only writer of the palette.** A program run outside this
  terminal (or over ssh into a different one) gets that terminal's colours, not
  these.
- **Glass has no conditional syntax.** `background-opacity` takes one value,
  not `light:…,dark:…`, so per-mode glass is `bin/theme` rewriting the file on
  every appearance flip rather than Ghostty resolving it. That does land live
  (SIGUSR2, 1.3.1 — the docs say a restart is required and they are wrong
  here), but it means anything that changes the appearance without going
  through `theme reload` leaves the outgoing mode's glass on screen. See
  "Glass".
- **A mode has one surface chroma, and some palettes do not.** cardboard's three
  paper tones desaturate as they darken (C 0.017 → 0.011 → 0.005) and a single
  `tint` cannot follow that curve. `bg` is reproduced exactly and the error
  lands on the tiers below it: slot 0 is 0.007 off in OKLab and `selection` is
  0.016, both inside the ~0.02 that is one perceptual step. Spreading the error
  evenly would have cost exactness on the most-seen colour in the theme to buy
  it on the least-seen.
- **The bar wears the theme's colours, not a reference's chrome.** cardboard's
  waybar is a shape as much as a palette — a blue-grey bar outside the sixteen
  slots, 2px ink borders, a two-tone inset bevel — and none of that is a colour
  change. sketchybar allows one border colour per background, so a bevel needs
  nested backgrounds per chip, and a skin is theme-wide by design: dark mode
  would wear it too. So light mode gets cardboard's six roles through whichever
  skin the theme names. Under `flat` that already reads as cardboard, paper bar
  and outlined chips; under `pill` the polarity is inverted — chips filled with
  slot 7, text in the background colour — which is legible but is not the
  reference.
