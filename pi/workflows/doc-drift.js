export const meta = {
  name: 'doc-drift',
  description: 'Fixes doc lines made stale by the window\'s changes and points copied volatile facts at their source, on one branch; lands nothing',
  whenToUse: 'Prompt /doc-drift: after a day of commits and rulings',
  phases: [
    { title: 'Changes', detail: 'commits and Joel\'s rulings in the window' },
    { title: 'Find', detail: 'doc lines that state each old fact' },
    { title: 'Fix', detail: 'one worker confirms and edits on a worktree branch' },
  ],
}
// args: { repo, since? = "24 hours ago" }
const { repo } = args
const since = args.since ?? '24 hours ago'

const CHANGES = {
  type: 'object', required: ['changes'], properties: { changes: { type: 'array', items: {
    type: 'object', required: ['source', 'kind', 'old', 'new'], properties: {
      source: { type: 'string', description: 'commit sha, or "Joel <date>"' },
      kind: { type: 'string', enum: ['path', 'command', 'number', 'host', 'decision'] },
      old: { type: 'string' }, new: { type: 'string', description: 'empty when deleted' } } } } },
}
const CANDIDATES = {
  type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', items: {
    type: 'object', required: ['path', 'line', 'text', 'source', 'proposed', 'reason'], properties: {
      path: { type: 'string', description: 'relative to the repo root' }, line: { type: 'integer' }, text: { type: 'string' },
      source: { type: 'string' }, proposed: { type: 'string', description: 'the replacement line' },
      reason: { type: 'string', enum: ['stale', 'copied-fact'] } } } } },
}
const FIXED = {
  type: 'object', required: ['branch', 'worktree', 'changes'], properties: {
    branch: { type: ['string', 'null'] }, worktree: { type: ['string', 'null'] },
    changes: { type: 'array', items: { type: 'object', required: ['path', 'line', 'before', 'after', 'source'], properties: {
      path: { type: 'string' }, line: { type: 'integer' }, before: { type: 'string' }, after: { type: 'string' }, source: { type: 'string' } } } },
  },
}

phase('Changes')
const found = await agent(`Repository ${repo}; window: since "${since}". Read only; change nothing.
1. \`git -C ${repo} log main --since="${since}" --stat --format='%h %s%n%b'\`.
2. Joel's own messages in that window from this repo's pi sessions: files in this repo's session directory modified in the window (find it by listing ~/.pi/agent/sessions and matching the directory name against ${repo}; if none matches, say so); read each with \`~/dotfiles/pi/kit/bin/pi-recall.mjs <file> list\`.
Return the changes a doc could state: a path moved or deleted, a command renamed, a number, a host, a decision. Each: source (the sha, or "Joel <date>"), kind, old, new. Leave out changes no doc would state. None at all: an empty list.`,
  { label: 'changes', phase: 'Changes', type: 'explore', model: 'haiku', schema: CHANGES })
const changes = found?.changes ?? []
if (!changes.length) return { branch: null, changes: [] }

phase('Find')
const groups = []
for (let i = 0; i < changes.length; i += 3) groups.push(changes.slice(i, i + 3))
const per = await pipeline(groups, (g, _, i) => agent(`Repository ${repo}; read only. For each change below, \`rg\` its old path, symbol, command or number across the repo's .md files (\`rg -n --glob '*.md' <old> ${repo}\`). Return candidate lines: path (relative to the repo root), line, text, the change's source, proposed (the replacement line), reason.
reason "stale": the line states the old fact and the new one replaces it. reason "copied-fact": the line copies a value that changes between landings (a duration, a queue or landing count, which host is up or used) that a command already prints; proposed names that command instead of the value. A value that changes rarely (a set size, a core count) is not copied-fact; when it changed, it is stale. Never put a shell pipeline in prose. Where a past example no longer applies, delete it rather than annotate it.
A dated record (a file or section dated in the past that reports what was true then) is not stale: skip it. Only lines tied to these changes; no other line.
Changes:
${g.map((c) => `- [${c.source}] ${c.kind}: ${c.old} -> ${c.new || '(deleted)'}`).join('\n')}`,
  { label: `find:${i + 1}`, phase: 'Find', type: 'explore', model: 'haiku', schema: CANDIDATES }))

const seen = new Set()
const candidates = per.filter(Boolean).flatMap((r) => r.candidates).filter((c) => {
  const k = `${c.path}:${c.line}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})
if (!candidates.length) return { branch: null, changes: [] }

phase('Fix')
const fixed = await agent(`Repository ${repo}. Do not touch its main checkout: read it only through \`git -C ${repo} show main:<path>\`.
1. Judge each candidate below against the repo at main: open the line, check the new fact in the code or the commit. Reject a wrong one silently; a dated record is not stale. Keep a copied-fact line only when the command it names exists at main. Reject an edit that makes the line longer without making it true, and one that states a declared fact (a config entry) as a measured one.
2. When none is confirmed, return branch null, worktree null, changes [] and create nothing.
3. Else \`git -C ${repo} worktree add "$(mktemp -d)/doc-drift-$(date +%F)" -b docs/drift-$(date +%F) main\` (the branch name gets a suffix if it exists), and edit only the confirmed lines there. Docs only; no other line.
4. Commit in that worktree: subject "docs: fix lines made stale by recent changes", the body listing each source (sha or Joel date) with its path:line.
Return branch, worktree (absolute path) and changes: path, line, before, after, source for each edited line.
Candidates:
${candidates.map((c) => `- ${c.path}:${c.line} [${c.source}] ${c.reason}\n    text: ${c.text}\n    proposed: ${c.proposed}`).join('\n')}`,
  { label: 'fix', phase: 'Fix', schema: FIXED })

return fixed ? { branch: fixed.branch, worktree: fixed.worktree, changes: fixed.changes } : { branch: null, worktree: null, changes: [] }
