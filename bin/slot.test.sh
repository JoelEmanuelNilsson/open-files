#!/bin/bash
# Walls bin/slot's grant rule: FIFO, priority waiters, backfill that never delays the head, lanes
# granted with cores, and dead entries cleared. Runs the real script on a temp
# state dir with a small budget. Usage: bash bin/slot.test.sh [path/to/slot]
set -u
SLOT=${1:-$(cd "$(dirname "$0")" && pwd)/slot}
T=$(mktemp -d)
pids=""
fails=0

finish() {
	touch "$T"/stop.all
	for p in $pids; do kill "$p" 2>/dev/null; done
	wait 2>/dev/null
	rm -rf "$T"
}
trap finish EXIT

# A fake Docker: a container "exists" while $T/container.<name> does.
mkdir -p "$T/fakebin"
printf '#!/bin/sh\nfor a; do n=$a; done\n[ -e "%s/container.$n" ]\n' "$T" > "$T/fakebin/docker"
chmod +x "$T/fakebin/docker"
export PATH="$T/fakebin:$PATH"

case_no=0
begin() {
	case_no=$((case_no + 1))
	S=$T/state$case_no
	M=$T/marks$case_no
	mkdir -p "$M"
	B=$2
	arrivals=0
	echo "case: $1"
}
fail() { echo "  FAIL: $1"; fails=$((fails + 1)); }

# job <name> <cores> [lane]: queue a job that records its grant and runs until stop.<name> exists.
job() {
	local name=$1 cores=$2 lane=()
	[ $# -gt 2 ] && lane=(--lane "$3")
	SLOT_STATE_DIR=$S SLOT_BUDGET=$B "$SLOT" ${lane[@]+"${lane[@]}"} --cores "$cores" -- bash -c \
		'echo "$SLOT_CORES ${SLOT_LANE:-}" > "$0/started.$1"; until [ -e "$0/stop.$1" ] || [ -e "$0/../stop.all" ]; do sleep 0.05; done' \
		"$M" "$name" 2>/dev/null &
	eval "pid_$name=$!"
	pids="$pids $!"
	arrivals=$((arrivals + 1))
	# Wait for the ticket, so arrival order is the order of the calls.
	local i=0
	until [ "$(cat "$S/next" 2>/dev/null)" = "$arrivals" ]; do
		sleep 0.05; i=$((i + 1)); [ $i -lt 100 ] || { fail "$name never queued"; return; }
	done
}
stop() {
	touch "$M/stop.$1"
	[ -e "$M/started.$1" ] || eval "kill \$pid_$1" 2>/dev/null
	eval "wait \$pid_$1" 2>/dev/null
}
# started <name> [seconds]: true once the job has been granted.
started() {
	local i=0 limit=$(( ${2:-4} * 20 ))
	until [ -e "$M/started.$1" ]; do sleep 0.05; i=$((i + 1)); [ $i -lt $limit ] || return 1; done
}
# Waiters poll once a second, so 2.5 s without a grant means they decided to wait.
settle() { sleep 2.5; }
expect_started() { started "$1" || fail "$1 did not start ($2)"; }
expect_waiting() { [ -e "$M/started.$1" ] && fail "$1 started ($2)"; }
expect_grant() { [ "$(cat "$M/started.$1" 2>/dev/null)" = "$2" ] || fail "$1 was granted '$(cat "$M/started.$1" 2>/dev/null)', not '$2'"; }

begin "FIFO when overtaking would delay the head" 4
job a 2; expect_started a "free budget"
job h 3; job x 2
settle
expect_waiting h "a holds 2 of 4"
expect_waiting x "x fits the free cores, but the head's 3 would then find only 0 when a ends"
stop a
expect_started h "a ended"
settle
expect_waiting x "h holds 3 of 4"
stop h
expect_started x "h ended"
stop x

begin "backfill up to budget - head - (largest subset of older jobs that fits beside the head)" 6
job a 2; job c 2; expect_started a "free budget"; expect_started c "free budget"
job h 3
job x 1
job y 1
settle
expect_waiting h "4 of 6 held"
expect_started x "6 - 3 - 2 leaves 1 core that cannot delay h"
expect_waiting y "x already took the 1 core that cannot delay h"
stop c
expect_started h "without backfill h would start when c ends, so with it too"
settle
expect_waiting y "a, x and h hold 6 of 6"
stop a; stop x; stop h
expect_started y "the queue drained"
stop y

begin "a SLOT_PRIORITY waiter goes ahead of earlier waiters, never ahead of running jobs" 4
job a 3
job h 3
SLOT_PRIORITY=1 job p 3
settle
expect_waiting p "a holds 3 of 4"
expect_waiting h "a holds 3 of 4"
stop a
expect_started p "a ended and p is ahead of h"
settle
expect_waiting h "p holds 3 of 4"
stop p
expect_started h "p ended"
stop h

begin "a lane is granted with the cores, never held while waiting for them" 4
job a 3
job h 2
job w1 3 lane-t
job w2 1 lane-t
settle
expect_waiting h "a holds 3 of 4"
expect_waiting w1 "w1 needs 3 cores"
expect_started w2 "lane-t is free while w1 waits for cores, and 1 core cannot delay h"
expect_grant w2 "1 lane-t"
stop a
expect_started h "a ended"
stop w2; stop h
expect_started w1 "a, h and w2 ended"
expect_grant w1 "3 lane-t"
job w3 1 lane-t
settle
expect_waiting w3 "w1 holds lane-t"
stop w1
expect_started w3 "w1 released lane-t"
stop w3

begin "the head's lane is not taken by a job overtaking it" 4
job a 3
job h 2 lane-t
job x 1 lane-t
settle
expect_waiting x "h, the head, wants lane-t"
stop a
expect_started h "a ended"
stop h
expect_started x "h released lane-t"
stop x

begin "a lane is taken while a Docker container of its name exists" 4
touch "$T/container.lane-c"
job d 1 lane-c
settle
expect_waiting d "container lane-c exists"
rm "$T/container.lane-c"
expect_started d "container lane-c removed"
stop d

begin "dead entries are cleared; first-version (6-line) entries count while alive" 4
mkdir -p "$S/queue" "$S/held"
echo 3 > "$S/next"; arrivals=3
printf '%s\n' 99999 "Thu Jan  1 00:00:00 1970" 4 0 / dead-head > "$S/queue/000000000002"
printf '%s\n' 99998 "Thu Jan  1 00:00:00 1970" 4 0 / dead-holder lane-t > "$S/held/000000000003"
sleep 30 & old=$!; pids="$pids $old"
printf '%s\n' "$old" "$(ps -o lstart= -p "$old")" 3 0 / old-version-holder > "$S/held/000000000001"
job e 2 lane-t
settle
expect_waiting e "the live first-version holder has 3 of 4"
[ -e "$S/queue/000000000002" ] && fail "the dead head's entry is still queued"
[ -e "$S/held/000000000003" ] && fail "the dead holder's entry is still held"
kill "$old"; wait "$old" 2>/dev/null
expect_started e "the first-version holder died"
[ -e "$S/held/000000000001" ] && fail "the dead first-version entry is still held"
stop e

echo "$([ $fails = 0 ] && echo PASS || echo "FAIL ($fails)")"
[ $fails = 0 ]
