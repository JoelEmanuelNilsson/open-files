# Spotify

Ads, skipped by hand — without the hand.

Free Spotify plays an ad; you find the window, quit it, start it again, press
play, and the ad is gone. That works because a fresh client comes back into
music instead of into the ad. This does exactly that, in about a second and a
half, and puts the window and the focus back so the only thing you notice is
that the ad stopped.

Nothing is patched, blocked, proxied or forged. The ad's impression is still
reported. This is the mildest thing in this space, and deliberately so.

## The parts

| File | What it is |
|---|---|
| `bin/spotify-ad-skip` | The watcher. All the logic. Edit this freely. |
| `SpotifyAdSkip.app` | Owns the macOS permission. **Never edit or rebuild.** |
| `build-app.sh` | Builds the app. Run once, on a new machine. |
| `com.joel.spotify-ad-skip.plist` | Starts it at login. |
| `~/.cache/spotify-ad-skip.log` | What it saw and what it did. |

## How an ad is noticed

Two rules, and nothing softer.

1. `spotify url of current track` starts with `spotify:ad:`. That prefix is a
   real URI scheme in the shipping binary, beside `spotify:track:`.
2. Spotify is **playing** but has no current track at all.

Rule 2 is the one that matters, because it is what was actually measured here
during a real ad. The client answered Apple Events normally, but `current
track` was `missing value`. So the obvious detector —

```bash
osascript -e 'tell application "Spotify" to return spotify url of current track'
```

— does not return a marker during an ad. It raises `-1700`, osascript exits
non-zero, and the caller gets an empty string and does nothing. For ever, with
no error anywhere. Every property is now read inside its own `try`, and "no
track" is a fact to be recorded rather than a crash.

Rule 2 is only safe because "no track" never happens otherwise: 190 samples at
20ms across four real track changes, while playing, produced zero. That is the
assumption holding this up — re-run the check if Spotify changes.

Deliberately **not** used: empty artist, `track number` = 0, duration under 40
seconds. Every tool that shipped those false-positives on podcasts, and a tool
that restarts Spotify in the middle of a podcast is worse than no tool.

## How the window gets put back

Where Spotify was decides which of two paths runs, and using the wrong one is
visible.

**Beside you.** `aerospace-summon` does the launching. Its cold-launch path
tiles, sizes and focuses inside a single AeroSpace request, so the first frame
the new window is drawn in is already the right one. Then focus goes back to
what you were using, because summon ends by focusing Spotify.

Summon has to do the launching, rather than being handed a window afterwards,
because **summon is a toggle**: give it a Spotify that already has a window in
this room and it puts the window away. The first version of this did exactly
that and helpfully hid Spotify every time an ad played.

**In the drawer.** Spotify force-activates its new window whatever `open` is
told — `-g` and `-j` do not stop it, which `aerospace.toml` already knew. So
the window does appear in the room you are standing in. It is noticed at 20ms
and sent home: measured, it is on screen for about 40ms, two or three frames.

If Spotify itself had focus, the captured window id belongs to a window about
to be destroyed. Focusing a dead id fails — and inside an `aerospace eval` a
failing command takes the whole request with it, so the *move* sharing that
request would silently not happen either. That case is detected and the new
window simply inherits the focus, which is what you wanted anyway.

## Three things that bite

**`open` fails about one time in eight.** Straight after killing Spotify it
returns `_LSOpenURLsWithCompletionHandler() failed ... error -600` —
procNotFound, LaunchServices still believing the process it just watched die is
alive. Nothing is born.

The damage lands later, which is what made it hard to see. `tell application
"Spotify"` *launches* Spotify when it is not running, so the play step starts
it behind the window handling's back: wrong room, focus taken, eleven seconds
of silence. The symptom looks nothing like the cause. So a launch is not "I ran
open", it is "a window now exists" — retried until one does.

**The first `playing` is a lie.** Spotify reports `playing` while the audio
engine is still coming up. Trust it only once `player position` has actually
moved.

**It always comes back paused.** Play has to be sent.

## The permission, which is the whole reason there is an app

macOS grants Automation to the *responsible process*, not to the script.

```
kTCCServiceAppleEvents | /bin/bash             | 0 | com.spotify.client   denied
kTCCServiceAppleEvents | com.mitchellh.ghostty | 2 | com.spotify.client   allowed
```

Run the watcher from the terminal and the responsible process is Ghostty, which
was allowed long ago — so it works, every time, and looks fine. Run it from
launchd and the responsible process is `/bin/bash`, shared by every script on
the machine and recorded here as denied. It then **hangs for ever on its first
question**, because launchd cannot put a consent dialog on screen. No error, no
log line, nothing.

Editing the database directly does not work either: `tccd` rewrote the row back
to `0` within seconds.

So the watcher needs an identity of its own, and that is all the app is. It
asks Spotify one harmless question — which is what makes macOS offer the
dialog — then starts the watcher and quits.

Two details in there are load-bearing:

- **No `LSUIElement`.** A UI-less app cannot present the consent dialog: with
  it set, the request sat at `authValue=1`, undecided, for ever, and nothing
  was drawn. Without it the prompt appears. The app quits immediately, so the
  Dock icon is there for a second at login and then gone.
- **The plist runs `open`, not the app's executable.** When a launchd job
  exits, launchd reaps whatever the job left running — so running the applet
  as the job gets the watcher killed a second later. Going through `open`
  hands the launch to LaunchServices, and the watcher outlives the job.

**Never rebuild the app.** Ad-hoc signing pins the grant to the bundle's hash.
Rebuild it and the grant stops applying, the watcher hangs, and ads come back
silently. `install.sh` builds it only when it is absent, for this reason. All
the logic lives in `bin/`, outside the bundle, so it can change for ever
without touching this.

If the grant is ever lost:

```sh
tccutil reset AppleEvents com.joel.spotify-ad-skip
open ~/dotfiles/spotify/SpotifyAdSkip.app     # then click Allow
```

## Using it

```sh
spotify-ad-skip --status    # what Spotify looks like this instant, and the verdict
spotify-ad-skip --once      # check now, act if it is an ad
tail -f ~/.cache/spotify-ad-skip.log
```

To prove the whole chain without waiting for an ad:

```sh
touch /tmp/spotify-ad-skip.simulate   # next check treats it as an ad
sleep 7
rm /tmp/spotify-ad-skip.simulate
```

Only one watcher ever runs — the lock is a `mkdir`, the atomic test-and-set
every shell has, so two starting at the same instant cannot both win. Starting
it again is a safe no-op.

If it ever reads something wrong, it restarts freely but stands down for five
minutes after four restarts inside two, and says so in the log. An ad break
holds more than one ad, so a second restart soon after the first is correct
behaviour, not a fault.

## It works, and here is the receipt

The first real ad it ever saw, 2026-09-01 at 16:26:23, straight out of the log:

```
change | AD | state=playing pos=0,273 url=spotify:ad:64432c759cec4ec19dcc93df5fb1090a
                                      name=[Reklamfri musik.] artist=[]
  restart: mode=hidden spotify_ws=1 here=2 prev_focus=292
  restart: playing, position advancing (0.0 -> 0.393)
change | ok | url=spotify:track:6BFccgWGhzVs1Fp3Sm4uS9 name=[Die Sonne lacht]
```

Caught 0.27 seconds into the ad. Back in music one second later, on the next
track, with the window still in its room and focus still on Chrome. Rule 1
fired -- the ad really does come through as `spotify:ad:`.

That exact line is now a test case, so it cannot regress silently.

Rule 2 -- playing with no current track -- has still never fired on a real ad.
It stays because it costs nothing, it is what was seen once during an earlier
ad, and it is tested. If it turns out to be dead weight it can go, but a rule
that has never produced a false positive in testing is not worth removing on
suspicion.

Cross-check, from Spotify's own bookkeeping in
`~/Library/Application Support/Spotify/Users/<id>-user/ad-state-storage.bnk`:

```
unix_epoch_of_last_impression = 1788272782   -> 16:26:22
```

One second before the watcher saw it. Two accounts have a folder in there; the
live one is whichever was written most recently, which is worth knowing before
drawing conclusions from a file that has not changed since March.
