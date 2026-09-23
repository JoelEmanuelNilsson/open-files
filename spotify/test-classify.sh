#!/usr/bin/env bash
#
# The one piece of judgement in the watcher is classify(): given what Spotify
# said, is this an ad? Everything else is mechanism. So it gets tested against
# real recorded probe lines -- every case below was produced by the real probe
# against the real client, not invented.
#
#   ./test-classify.sh

set -u
SKIP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/spotify-ad-skip"
pass=0
fail=0

want() {
  local expect="$1" desc="$2" probe="$3" got
  got=$("$SKIP" --classify "$probe")
  if [ "$got" = "$expect" ]; then
    pass=$((pass + 1))
    printf '  ok    %-52s -> %s\n' "$desc" "$got"
  else
    fail=$((fail + 1))
    printf '  FAIL  %-52s -> %s (wanted %s)\n' "$desc" "$got" "$expect"
    printf '        probe was: %s\n' "$probe"
  fi
}

echo "ADS -- must be caught"

# THE REAL ONE. Copied verbatim out of the log at 16:26:23 on 2026-09-01, the
# first real ad this ever saw. Caught 0.27s in; music was back one second
# later. Note the empty artist -- that is why the podcast cases below matter,
# because an empty artist alone would catch both.
want ad "the real ad, verbatim from the log" \
  'state=playing pos=0,273000001907 url=spotify:ad:64432c759cec4ec19dcc93df5fb1090a name=[Reklamfri musik.] artist=[]'

# Rule 1. The URI scheme is real: `spotify:ad:` is in the shipping Mach-O, and
# xpui.js builds `spotify:ad:${adId}` in three places.
want ad "ad by URI, playing" \
  'state=playing pos=3,1 vol=100 url=spotify:ad:1234abcd name=[Advertisement] artist=[]'
want ad "ad by URI, no metadata at all" \
  'state=playing pos=0,5 vol=100 url=spotify:ad:xyz name=[] artist=[]'
want ad "ad by URI even if state looks odd" \
  'state=paused pos=0,0 vol=100 url=spotify:ad:xyz name=[] artist=[]'

# Rule 2. This is what a real ad looked like on this machine: the client
# answered normally, but `current track` was `missing value`.
want ad "playing with no current track" \
  'state=playing pos=3,1 vol=100 track=MISSING'
want ad "playing, current track raised on read" \
  'state=playing pos=3,1 vol=100 url=ERR name=ERR artist=ERR'

echo
echo "NOT ADS -- must never be touched"

# The one that matters most. Podcasts are why every metadata heuristic in every
# other tool is wrong: empty artist, short duration and track number 0 all
# happen on ordinary episodes.
want no "podcast with an empty artist" \
  'state=playing pos=12,0 vol=100 url=spotify:episode:5abc name=[Ep 12] artist=[]'
want no "track literally named Advertisement" \
  'state=playing pos=12,0 vol=100 url=spotify:track:5abc name=[Advertisement] artist=[Spotify]'
want no "artist literally called Spotify" \
  'state=playing pos=12,0 vol=100 url=spotify:track:5abc name=[Playlist] artist=[Spotify]'
want no "ordinary track" \
  'state=playing pos=74,9 vol=100 url=spotify:track:4bpyHh2wlR34r0ESXeZgU8 name=[stan.ssl - Slowed] artist=[muyshai]'
want no "ordinary track, paused" \
  'state=paused pos=0,0 vol=100 url=spotify:track:0PUi8C3der9IVNFaksxTiw name=[Rain] artist=[Candlebox]'

echo
echo "RESTART TURBULENCE -- must not trigger another restart"

# These are recorded from the moments around a real restart. If any of them
# read as an ad, the watcher restarts Spotify because it just restarted
# Spotify, for ever.
want no "Spotify dying: connection invalid" \
  'state=stopped pos=missing value vol=0 CURTRACK_ERR=[Spotify got an error: Connection is invalid.]'
want no "Spotify not up yet: everything errors" \
  'state=ERR pos=ERR track=MISSING'
want no "stopped with no track" \
  'state=stopped pos=0,0 vol=100 track=MISSING'
want no "paused with no track" \
  'state=paused pos=0,0 vol=100 track=MISSING'
want no "empty probe" ''

# The two states the pid-targeted probe reports and the name-targeted one could
# not. Both mean "there is nothing to ask", and the watcher's answer to that has
# to be `no`: an ad verdict here restarts the Spotify you just quit.
want no "Spotify is not running at all" \
  'state=NOT_RUNNING'
want no "Spotify quit mid-probe" \
  'state=GONE'

echo
echo "=== pass=$pass fail=$fail ==="
[ "$fail" -eq 0 ]
