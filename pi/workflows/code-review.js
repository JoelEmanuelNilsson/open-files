export const meta = {
  name: 'code-review',
  description: 'Whole code review in one call: scope, Haiku reviewers, a Sonnet check per blocking claim, an Opus judge; returns only the verdict',
  whenToUse: 'Skill code-review: before landing a diff a check cannot judge',
  phases: [
    { title: 'Scope', detail: 'pin the revs, split the diff into scopes' },
    { title: 'Review', detail: 'one reviewer per scope' },
    { title: 'Check', detail: 'one worker per blocking claim or file group' },
    { title: 'Judge', detail: 'design-review reads the confirmed set' },
    { title: 'Record', detail: 'write record.md and advisory.md' },
  ],
}
// args: { repo, base, head, spec?, scopes?: [{ name, files: [...] }], out? }
const { repo, base, head } = args
const CODE_REVIEW = '~/.agents/skills/code-review/SKILL.md'
const failed = []
const named = (label, call) => call.then(
  (r) => { if (r == null) failed.push(`${label}: no result (died, stopped or never fit its schema)`); return r },
  (e) => { failed.push(`${label}: ${e?.message ?? e}`); return null },
)
const spec = args.spec ? `Spec (text, or a path to read): ${args.spec}` : 'Spec: none given; skip the Spec axis.'
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-')

const PIN = {
  type: 'object', required: ['baseSha', 'headSha', 'headShort', 'scopes', 'error'], properties: {
    baseSha: { type: 'string' }, headSha: { type: 'string' }, headShort: { type: 'string', description: 'git rev-parse --short output for head' },
    scopes: { type: 'array', items: { type: 'object', required: ['name', 'files'], properties: { name: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } },
    error: { type: 'string', description: 'empty when the revs resolve and the diff is non-empty; else the failing command and its output' },
  },
}
phase('Scope')
const pin = await named('scope', agent(`Repository: ${repo}. Run every command as \`git -C ${repo} ...\`.
1. \`git -C ${repo} rev-parse ${base} ${head}\` and \`git -C ${repo} rev-parse --short ${head}\`. A bad rev: put the command and its output in error and stop.
2. \`git -C ${repo} diff --name-status ${base}...${head}\`. An empty diff: error "empty diff" and stop.
${args.scopes ? '3. Scopes are given by the caller: return scopes as an empty array.' : `3. Split the changed files into review scopes. Leave out deleted files, docs-only files (markdown, text) and test-only changes whose source did not change. Each scope is one or two source files plus their test files (match by name: foo.ts with foo.test.*); a file over 800 changed lines (\`git -C ${repo} diff --numstat ${base}...${head}\`) is its own scope. Name each scope after its main file. Paths relative to the repo root.`}
Return baseSha, headSha, headShort, scopes, and error ("" when none).`,
  { label: 'scope', phase: 'Scope', type: 'explore', schema: PIN }))
if (!pin || pin.error) return { fix: [], design: [], advisory: null, record: null, failed: pin ? [`scope: ${pin.error}`] : failed }

const B = pin.baseSha, H = pin.headSha
const out = (args.out ?? `${repo}/.scratch/code-review/${pin.headShort}`).replace(/\/$/, '')
const scopes = args.scopes ?? pin.scopes
const rel = (p) => p.startsWith(`${repo}/`) ? p.slice(repo.length + 1) : p

const FINDINGS = {
  type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
    type: 'object', required: ['path', 'line', 'severity', 'axis', 'claim', 'evidence'], properties: {
      path: { type: 'string', description: 'relative to the repo root' }, line: { type: 'integer' },
      severity: { type: 'string', enum: ['blocking-candidate', 'advisory'] },
      axis: { type: 'string', enum: ['Standards', 'Spec', 'Risk', 'Design'] },
      claim: { type: 'string' }, evidence: { type: 'string', description: 'command and result, path:line, or "inferred"' } } } } },
}
const CHECK = {
  type: 'object', required: ['results'], properties: { results: { type: 'array', items: {
    type: 'object', required: ['id', 'verdict', 'why', 'probe', 'reachable'], properties: {
      id: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed', 'rejected'] }, why: { type: 'string', description: 'one line' },
      probe: { type: 'string', description: 'probe path and command with its output, or "read <path:line>"' },
      reachable: { type: 'string', description: 'the caller, input or event that reaches it, path:line; or "none found"' },
      direction: { type: 'string', description: 'when confirmed: the direction of the fix in one line, not a patch' } } } } },
}

// Merge: same class, same path, lines within 5, claims sharing half their words.
const words = (s) => new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2))
const overlap = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)) }
const entries = { block: [], advisory: [], design: [] }
const merge = (f, cls) => {
  const w = words(f.claim)
  const same = entries[cls].find((e) => e.path === f.path && Math.abs(e.line - f.line) <= 5 && overlap(e.words, w) >= 0.5)
  if (same) { same.members.push(f); return null }
  const e = { ...f, words: w, members: [f] }
  entries[cls].push(e)
  return e
}

const reviewed = await pipeline(
  scopes,
  (s, _, i) => {
    const pad = `${out}/notepads/${String(i + 1).padStart(2, '0')}-${slug(s.name)}`
    return named(`review:${s.name}`, agent(`Code review, scope "${s.name}": ${s.files.join(', ')}.
Repository ${repo}; run commands from \`cd ${repo}\`. Range: base ${B}, head ${H}. Diff: \`git diff ${B}...${H} -- ${s.files.join(' ')}\`; log: \`git log --oneline ${B}..${H}\`. Review the files as they are at head (\`git show ${H}:<path>\` when the working tree differs). You may read callers and tests outside the scope; report findings on the scope.
${spec}
Standards: every AGENTS.md and CLAUDE.md from the repo root to each file; ~/.agents/skills/coding-standards/SKILL.md, ~/.agents/skills/write-discoverable-code/SKILL.md, ~/.agents/skills/principles/SKILL.md, ~/.agents/skills/coding-standards/references/comments-and-jsdoc.md; the repo's test rules when present (.agents/skills/test-audit/SKILL.md). The bloat list and the smell baseline are section 3 of ${CODE_REVIEW}; both advisory, and a documented repo rule overrides them.
Per file and hunk, report correctness bugs, edge cases, error handling, leaks, test gaps and breaches of the documented rules, each as \`path:line  severity  claim  (evidence)\`. Quote the spec line for a requirement that is missing, extra or wrong. A documented repo rule overrides the baseline. Check only what no lint or other tooling enforces. For Risk, name the one fact the change is safe because of and prove it, then look where grep stops (library source at its pinned version, JSON shapes, DB columns, wire formats, feature flags, code three hops downstream). Label each finding with its axis: Standards, Spec or Risk. A design question (right module, abstraction, API, where the code lives) gets axis Design with its path:line and the facts that raise it; do not judge it.
Severity: blocking-candidate when it is a defect with a reachable path (name the caller, input or event), a breach of a documented rule (quote it), or a spec requirement missing or wrong; everything else advisory.
Your notepad is ${pad}.md: write each finding there the moment you find it, and re-read it after a compaction. Probe scripts go under ${pad}-probes/. Those are the only files you write; change no repo file.
Return every finding, not only the most severe.`,
      { label: `review:${s.name}`, phase: 'Review', type: 'reviewer', schema: FINDINGS })).then((r) => r && { pad: `${pad}.md`, findings: r.findings.map((f, k) => ({ ...f, path: rel(f.path), id: `${i + 1}.${k + 1}`, scope: s.name })) })
  },
  async (rev, s, i) => {
    const mine = []
    for (const f of rev.findings) {
      const e = merge(f, f.axis === 'Design' ? 'design' : f.severity === 'advisory' ? 'advisory' : 'block')
      if (e && f.axis !== 'Design' && f.severity !== 'advisory') mine.push(e)
    }
    const groups = []
    for (const path of [...new Set(mine.map((e) => e.path))]) {
      const all = mine.filter((e) => e.path === path)
      for (let k = 0; k < all.length; k += 3) groups.push(all.slice(k, k + 3))
    }
    const checks = await parallel(groups.map((g) => () => {
      const label = `check:${g.map((e) => e.id).join(',')}`
      return named(label, agent(`Check code review claims; you are a checker, not a fixer. Repository ${repo}, range ${B}...${H}, read at head ${H}.
Edit no repo file. Write probes only as ${out}/probes/<id>.<ext>, the claim's id in the name. Run read-only commands and the repo's existing tests.
For each claim: open its path:line; re-run its evidence when it names a command, else write the smallest probe that calls the real code and reproduces the claim, and run it. confirmed only when you reproduced it or the line shows it beyond doubt (say which); rejected names the fact that refutes it. Find the caller, input or event that reaches it, or say "none found". For a confirmed claim, give the direction of the fix in one line.
${spec}
Claims:
${g.map((e) => `[${e.id}] ${e.path}:${e.line}  ${e.axis}  ${e.claim}  (evidence: ${e.evidence})`).join('\n')}`,
        { label, phase: 'Check', schema: CHECK }))
    }))
    for (const [k, g] of groups.entries()) for (const e of g) {
      const r = checks[k]?.results.find((x) => x.id === e.id)
      if (r) e.check = r
      else if (checks[k]) failed.push(`check:${e.id}: no verdict returned`)
    }
    return { scope: s.name, pad: rev.pad }
  },
)

const confirmed = entries.block.filter((e) => e.check?.verdict === 'confirmed')
const rejected = entries.block.filter((e) => e.check?.verdict === 'rejected')
const unchecked = entries.block.filter((e) => !e.check)
const line = (e) => `[${e.id}] ${e.path}:${e.line}  ${e.axis}  ${e.claim}  (evidence: ${e.evidence})${e.members.length > 1 ? `  [also ${e.members.slice(1).map((m) => m.id).join(', ')}]` : ''}`
const checked = (e) => `${line(e)}\n    check: ${e.check.verdict}: ${e.check.why}\n    reachable: ${e.check.reachable}\n    probe: ${e.check.probe}`

const VERDICT = {
  type: 'object', required: ['fix', 'design', 'advisory', 'notes'], properties: {
    fix: { type: 'array', items: { type: 'object', required: ['ids', 'path', 'line', 'problem', 'direction'], properties: {
      ids: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, line: { type: 'integer' }, problem: { type: 'string' }, direction: { type: 'string' } } } },
    design: { type: 'array', items: { type: 'object', required: ['ids', 'verdict', 'covers', 'direction'], properties: {
      ids: { type: 'array', items: { type: 'string' } }, verdict: { type: 'string' }, covers: { type: 'array', items: { type: 'string' } }, direction: { type: 'string' } } } },
    advisory: { type: 'array', items: { type: 'object', required: ['id', 'why'], properties: { id: { type: 'string' }, why: { type: 'string' } } } },
    notes: { type: 'string', description: 'your reasoning for the record, including each design question you answered no, with why' },
  },
}
const judge = confirmed.length >= 2 || entries.design.length > 0
let verdict = { fix: [], design: [], advisory: [], notes: '' }
if (judge) {
  phase('Judge')
  const judged = await named('judge', agent(`Judge a code review. Repository ${repo}, range ${B}...${H}, read at head ${H}. ${spec}
The criteria are section "6. Judge the findings" of ${CODE_REVIEW}: read it first. Each finding below was confirmed by a checker who reproduced it.
1. Read the confirmed findings as a set before ruling on any. Group findings with one cause. Many findings, a cluster in one module, one class in several places, or fixes that fight the code's structure point above the line: ask whether the design is right, whether the architecture is (where the code lives, who owns it), and whether a standard is wrong or missing. When one is, give a design entry (verdict, the paths it covers, the direction) and list the ids under it; those ids get no fix entry.
2. Classify every other confirmed finding by the criteria: blocking (one fix entry per cause: the root path:line, the problem, the direction of the fix, not a patch, and the ids it covers) or advisory (id and one line why).
3. Answer each design question below: a design entry when it holds, else a line in notes saying why not.
Every confirmed id lands in exactly one of fix, design or advisory.

Confirmed findings:
${confirmed.map(checked).join('\n') || '(none)'}

Design questions from the reviewers:
${entries.design.map(line).join('\n') || '(none)'}`,
    { label: 'judge', phase: 'Judge', type: 'design-review', schema: VERDICT }))
  if (judged) verdict = judged
  else verdict.notes = 'Judge failed: the confirmed findings below are unjudged.'
  const placed = new Set([...verdict.fix.flatMap((f) => f.ids), ...verdict.design.flatMap((d) => d.ids), ...verdict.advisory.map((a) => a.id)])
  const loose = confirmed.filter((e) => !placed.has(e.id)).map((e) => e.id)
  if (judged && loose.length) failed.push(`judge: left ${loose.join(', ')} unclassified; see the record`)
} else {
  verdict = {
    fix: confirmed.map((e) => ({ ids: [e.id], path: e.path, line: e.line, problem: e.claim.length > e.check.why.length ? e.check.why : e.claim, direction: e.check.direction || e.check.why })),
    design: [], advisory: [],
    notes: `Judge skipped: ${confirmed.length} finding(s) confirmed and no design question raised; each confirmed finding returns as its checker stated it.`,
  }
}

phase('Record')
const byId = Object.fromEntries(confirmed.map((e) => [e.id, e]))
const advisoryMd = [
  `# Advisory findings: ${repo} ${B}...${H}`,
  '',
  '## Confirmed, judged advisory',
  ...verdict.advisory.map((a) => `- ${byId[a.id] ? line(byId[a.id]) : `[${a.id}]`}\n  judge: ${a.why}`),
  '',
  '## Reported advisory, not checked',
  ...entries.advisory.map((e) => `- ${line(e)}`),
].join('\n')
const record = [
  `# Code review: ${repo} ${B}...${H}`,
  '', spec, '',
  '## Scopes and notepads',
  ...scopes.map((s, i) => `- ${s.name}: ${s.files.join(', ')} — ${reviewed[i]?.pad ?? 'review failed'}`),
  ...(failed.length ? ['', '## Failed', ...failed.map((f) => `- ${f}`)] : []),
  '', '## Verdict: fix',
  ...verdict.fix.map((f) => `- ${f.path}:${f.line} ${f.problem} → ${f.direction} (${f.ids.join(', ')})`),
  '', '## Verdict: design',
  ...verdict.design.map((d) => `- ${d.verdict} — covers ${d.covers.join(', ')} → ${d.direction} (${d.ids.join(', ')})`),
  ...['Standards', 'Spec', 'Risk'].flatMap((axis) => ['', `## Confirmed: ${axis}`, ...confirmed.filter((e) => e.axis === axis).map((e) => `- ${checked(e)}`)]),
  '', '## Rejected', ...rejected.map((e) => `- ${checked(e)}`),
  '', '## Unchecked (checker failed)', ...unchecked.map((e) => `- ${line(e)}`),
  '', '## Design questions', ...entries.design.map((e) => `- ${line(e)}`),
  '', '## Judge notes', verdict.notes,
  '', `## Advisory`, `${out}/advisory.md`,
].join('\n')
const WROTE = { type: 'object', required: ['bytes'], properties: { bytes: { type: 'integer' } } }
const utf8Bytes = (s) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4 } return n }
const write = (path, text) => named(`write:${path}`, agent(`Write the text between the BEGIN and END lines to ${path} exactly as given, creating its directory; nothing else. Then run \`wc -c ${path}\` and return the byte count.
BEGIN
${text}
END`, { label: `write:${path.split('/').pop()}`, phase: 'Record', model: 'haiku', schema: WROTE })).then((r) => {
  const want = utf8Bytes(text)
  if (r && r.bytes !== want && r.bytes !== want + 1) failed.push(`write:${path}: file has ${r.bytes} bytes, the text has ${want}; the copy is truncated or changed`)
})
await parallel([() => write(`${out}/record.md`, record), () => write(`${out}/advisory.md`, advisoryMd)])

return {
  fix: verdict.fix.map(({ path, line, problem, direction }) => ({ path, line, problem, direction })),
  design: verdict.design.map(({ verdict, covers, direction }) => ({ verdict, covers, direction })),
  advisory: `${out}/advisory.md`,
  record: `${out}/record.md`,
  ...(failed.length ? { failed } : {}),
}
