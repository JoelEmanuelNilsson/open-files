---
description: Fix docs made stale by today's commits and Joel's rulings, on one branch
argument-hint: "[since, default 24 hours ago]"
---
Call `Workflow { name: "doc-drift", args: { repo: <this repo's root, from git rev-parse --show-toplevel>, since: "${1:-24 hours ago}" } }`. Relay the returned changes to Joel as one line each with its source, and the branch to land if he agrees. Land nothing. No changes: say so.
