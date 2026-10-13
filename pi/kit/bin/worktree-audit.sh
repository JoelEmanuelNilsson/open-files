#!/usr/bin/env bash
# Read-only worktree audit: size, age, merged, dirty and session references for
# every worktree but the main one, sorted by size. Never deletes anything.
# Usage: worktree-audit.sh [repo-path] [window-days]   (defaults: current repo, 7)
set -u

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
days="${2:-7}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1

main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
sessions=$(find "$HOME/.pi/agent/sessions" -name '*.jsonl' -mtime "-$days" 2>/dev/null)
now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREFERENCED\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r wt; do
	[ "$wt" = "$main_wt" ] && continue

	size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
	head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
	age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")

	merged=no
	branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
	if git -C "$wt" merge-base --is-ancestor HEAD main 2>/dev/null; then merged=YES
	elif [ -n "$branch" ] && [ -z "$(git cherry main "$branch" 2>/dev/null | grep '^+')" ]; then merged=YES; fi

	porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
	if [ -z "$porcelain" ]; then dirty=clean
	else dirty="tracked:$(printf '%s\n' "$porcelain" | grep -cv '^??'),untracked:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

	referenced=no
	[ -n "$sessions" ] && printf '%s\n' "$sessions" | xargs rg -l -F "$wt" >/dev/null 2>&1 && referenced=yes

	if [ "$dirty" != clean ]; then bucket=hold-dirty
	elif [ "$referenced" = yes ]; then bucket=hold-referenced
	elif [ "$merged" = YES ]; then bucket=safe
	else bucket=review; fi

	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$size" "$age" "$merged" "$dirty" "$referenced" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh
