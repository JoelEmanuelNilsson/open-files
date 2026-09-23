# AeroSpace

The window manager. Keyboard only, no dragging, no animation.

Two ideas run all of it.

**Rooms.** One room is on screen. The rest are parked in a corner off the
display. Switching is instant because nothing moves but the windows. These are
not macOS Spaces — AeroSpace ignores those.

**A layer.** Normally AeroSpace watches two keys: `º` `ç`. Press one and
plain letters mean things until the layer closes. Same shape as Neovim's normal
mode.

Everything else here is a consequence of those two.

## The rooms

| Room | Holds | Why one window |
|---|---|---|
| 1 | Ghostty | herdr splits it into projects inside |
| 2 | Chrome | tabs do the same for pages |
| 3 | everything else | the drawer |

Rooms 1 and 2 hold exactly one window each, so both are full screen by
arithmetic rather than by rule. Nothing needs a second Ghostty window, because
herdr already multiplexes inside the one.

Every room is an **accordion**: one window fills it; a second lands on top at
full width, and the one underneath peeks out 30px at the sides. So a summoned
Finder covers the terminal rather than squeezing beside it, and an app that
cannot shrink (Spotify, Wispr Flow's dashboard) is not a special case.

**The rooms heal themselves.** A birth rule puts Ghostty in 1 and Chrome in
2, but a rule runs once, and ⌘W-and-reopen or a mis-aimed key could leave the
terminal in the drawer for good. So every room key re-checks the two homes
after it switches (`bin/aerospace-heal`, ~60ms), and so does startup. Press
`t` and you get the terminal, whatever happened before.

System Settings floats on its own — it has no fullscreen button, so AeroSpace's
dialog heuristic catches it. Wispr Flow sits at window level 1000, which
AeroSpace treats as a popup and never manages. Neither needs a line of config.

## Why bare keys and not chords

On a Spanish ISO keyboard the left Option key types `| @ # ~ [ ] { } \`. Option
is a typing key here, not a modifier. Every alt-based config on the internet is
unusable as written, for that one reason. Ghostty already knows this:
`macos-option-as-alt = right`.

So the leader keys are two characters that are never typed on this machine:
`º` `ç`. Both open the same layer. After a week, delete the one your hand does
not reach for. `¡` is not one of them: it is remapped to F12 for herdr.

A key bound here is grabbed by the OS and never reaches any app again. That is
the whole cost of the design, and it is why Neovim gave up `º` and `ç` — they
used to be its jumplist keys, and a binding there would look correct and do
nothing.

## The keys

Press a leader key first. `esc` and `q` close the layer.

**Going somewhere — the layer closes behind you**

| Key | Does |
|---|---|
| `1` `2` `3` | go to that room (`t` terminal and `c` Chrome do the same by name) |
| `space` | back to the room you came from |
| `f` `e` `s` | bring Finder / TextEdit / Spotify on top of this room — press again to send it home |
| `x` | send whatever is focused home: Ghostty to 1, Chrome to 2, anything else to 3 |
| `shift-1/2/3` | throw this window into that room and follow it |
| `enter` | full screen |

**Arranging what is in front of you — the layer stays open**

| Key | Does |
|---|---|
| `tab` | next window in this room — pop-ups included |
| `shift-tab` | the one before |
| arrows | move focus |
| shift + arrows | move the window |
| `-` `+` | smaller, bigger |
| `a` | accordion, the default — press again to flip its direction |
| `d` | side by side |
| `shift-j` `shift-l` | nest this window under its neighbour |
| `r` | flatten the room back to a flat row |
| `backspace` | close everything here but this |
| `esc` | reload the config and leave the layer |

Every other key on the board closes the layer. Not tidiness — the difference
between a mode and a trap. Unbound keys in AeroSpace fall through to the app
underneath and leave the mode open, so one stray letter would type into your
terminal and strand you in a layer with nothing on screen to say so.

The price: promoting a key to a real command means deleting it from the
catch-all list at the bottom of the config. A key written twice in one mode is a
duplicate TOML key, and AeroSpace then rejects the whole file. `install.sh
--doctor` fails on that before you find out the hard way.

## Getting back to a window that is covered

A pop-up that AeroSpace floats — System Settings is the one you will meet —
sits on top of the room rather than in it. Focus the terminal and the terminal
covers it. It is still there, and nothing on screen says so.

`º tab` is the way back. It walks every window in the room in order and raises
the one it lands on, floating windows included: AeroSpace lends them a place in
that order for the length of the command.

The arrows cannot do this. They move by geometry, and a window lying on top of
another is neither left of it nor right of it.

Once you are on it, `º x` puts it away in the drawer — that works on floating
windows too. `x` sends a window to *its* home, so pressing it on the terminal
by mistake does nothing at all.

There is no cycling between rooms, on purpose. Rooms are the unit you switch
with `1` `2` `3`; `tab` is the unit inside one.

## Summoning

`º f` puts Finder on top of your terminal at full width. Press it again and
Finder goes home, and the terminal is full screen again because it is alone in
the room.

`º x` is the same idea for anything that has no key of its own.

The work is in [`bin/aerospace-summon`](bin/aerospace-summon): move the window
here and focus it, in one `aerospace eval` so the room redraws once. If the
app has no window (cold, or ⌘W'd), `open -g` asks for one without raising the
app; it is born in this room and lands on top.

The three scripts share one fact — which app lives where — and none of them
state it. [`bin/aerospace-lib`](bin/aerospace-lib) reads it out of the
`[[on-window-detected]]` rules in `aerospace.toml`. Add a pinned app there and
`x`, the heal and the summon keys all learn it.

## The focus line

AeroSpace draws nothing on screen, so with two windows side by side there is
nothing to say which one your typing goes to. [JankyBorders](https://github.com/FelixKratz/JankyBorders)
draws one hairline around the focused window.

```
width = 3.0   two device pixels
```

Half the border is drawn under the window, so you see about a pixel less than
you ask for: `2.0` gives one device pixel, `3.0` gives two, `4.0` gives three.

`borders <settings>` talks to a running daemon if it can reach one, and otherwise
becomes one and never returns. The instance AeroSpace used to start was not
reachable from the bar's bridge (measured), so every retune became a second
daemon and blocked the bridge. So `sketchybar/bin/bridge-aerospace` starts and
owns the single daemon, with both colours fully transparent: nothing is
outlined while you work. It sets `active_color` to the theme's accent when the
leader layer opens and back to transparent when it closes, so the outline
answers exactly one question — which window the next key acts on. No bar, no
border.

## What it rests on

```bash
brew install --cask aerospace
brew install FelixKratz/formulae/borders
~/dotfiles/install.sh          # links ~/.aerospace.toml, makes bin/* executable
```

AeroSpace needs Accessibility permission — macOS asks on first launch.

- `start-at-login = true`, like every config worth copying. The escape hatch
  is `aerospace enable off` from any terminal, not a reboot.
- `auto-reload-config = false`. A config that reloads on every keystroke of a
  half-written edit puts you in a broken layout while you are still typing.
  `º esc` reloads it when you mean to.
- Execs get Homebrew's prefix on their PATH explicitly. Otherwise they inherit
  whatever environment AeroSpace was started with, and starting it from Finder
  would leave `borders` and the summon script's own `aerospace` calls
  unresolvable — keys that quietly do nothing.

## Decisions already made

Written down so they are not re-argued.

- **Accordion, not tiles.** A second window should cover the terminal, not
  squeeze it: apps with a minimum width (Spotify, Wispr Flow) cannot take a
  third, and cut their content instead. Horizontal, so the peek is left/right
  and Ghostty keeps its whole number of rows. The known cost: Ghostty is
  translucent, so a window peeking behind it shows faintly through the glass
  while it is there. Send it home and it is gone.
- **Numbers, not letters, for rooms.** There are three rooms, so `1` `2` `3` need no
  legend; `t` and `c` exist for the two that have names.
- **No app picker.** Raycast already launches apps.
- **No floating windows.** Floating means dragging with a mouse, and AeroSpace
  cannot move or resize a floating window by command at all — the source returns
  an explicit "not supported". (Born-floating as a delivery trick existed when
  rooms were tiles; accordion made it unnecessary.)
- **Heal on the room keys, not in a daemon.** A watcher on `aerospace subscribe`
  would fix a stray the instant it happens, at the cost of one more process to
  keep alive. A stray you cannot see until you go looking, and the room key is
  how you go looking.
- **Right Option as a fourth leader key: deferred.** A bare modifier has to be
  translated into a bindable key by Karabiner-Elements, which is another
  always-running dependency. Only worth it if `º` and `¡` prove too few.
- **`sectionSign`, not `backtick`.** AeroSpace names keys by physical US-QWERTY
  position. Apple's ISO boards swap two keycodes against ANSI: the key left of
  `1` is `sectionSign`, the key left of `Z` is `backtick`. Bind `backtick` here
  and you steal `<` and `>`, which are typed constantly, while `º` still types a
  `º` — which looks exactly like a config that did not load.

## Known limits

- **Dock and Spotlight open apps where you are.** A window with no rule lands
  on top of the room you are in. `x` or its summon key puts it in the drawer.
- **A window behind Ghostty shows through the glass.** Ghostty is translucent;
  the accordion's peek is 30px of another window at each side. Send it home
  and it is gone.
- **TextEdit cold-launches into an Open dialog**, which macOS floats and
  AeroSpace does not list. It lands from the second summon on.
- **A stray heals on the next room key, not instantly.** Between the stray and
  the key you may see Ghostty in the drawer. Press `t`.

## When it goes wrong

```bash
aerospace enable off     # stop it managing windows, and listening to the keyboard
aerospace enable on      # back
aerospace reload-config  # same as º esc
./install.sh --doctor    # keys, scripts, duplicate bindings, borders installed
```

`enable off` is the way back in from any terminal if a binding ever locks you
out.
