export const meta = {
  name: 'skill-eval',
  description: 'Blind eval of skill variants: sanitized dirs, same organic prompt, one opus judge, session-log reads',
  whenToUse: 'Playbook skill-change, when an edit changes what an agent does',
  phases: [
    { title: 'Run', detail: 'set up a dir, run the candidate, list its reads' },
    { title: 'Judge', detail: 'one blind pass over all outputs' },
  ],
}
// args: { variants: [{label, skillPaths: {name: absPathToSKILL.md-or-dir}}], prompt, rubric: [..], project?, candidatesPerVariant?, model?, runId? }; runId names this run's dirs, default a hash of args, so give a new one to repeat identical args
const N = args.candidatesPerVariant ?? 2
const MODEL = args.model ?? 'sonnet'
const SKILLS = '.agents/skills'
const items = []
for (let c = 0; c < N; c++) args.variants.forEach((v, vi) => items.push({ v, vi, c, n: items.length + 1 }))
const RUN = args.runId ?? [...JSON.stringify(args)].reduce((h, ch) => (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0, 7).toString(36)
const dirOf = (it) => `/tmp/site-work-${RUN}-${String(it.n).padStart(3, '0')}`
const labelOf = (it) => `site-${it.n}`

const SETUP = { type: 'object', required: ['ok', 'installed', 'note'], properties: { ok: { type: 'boolean' }, installed: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } }
const READS = { type: 'object', required: ['sessions', 'reads', 'skillsOpened'], properties: { sessions: { type: 'array', items: { type: 'string' } }, reads: { type: 'array', items: { type: 'string' } }, skillsOpened: { type: 'boolean' } } }

const results = await pipeline(
  items,
  (it) => {
    const copies = Object.entries(it.v.skillPaths).map(([name, p]) =>
      `src='${p}'; [ -f "$src" ] && src=$(dirname "$src"); mkdir -p '${dirOf(it)}/${SKILLS}/${name}' && cp -R "$src"/. '${dirOf(it)}/${SKILLS}/${name}/'`).join('\n')
    return agent(`Shell setup, no judgment. Run:
rm -rf '${dirOf(it)}' && mkdir -p '${dirOf(it)}'
${args.project ? `cp -R '${args.project}'/. '${dirOf(it)}'/ && rm -rf '${dirOf(it)}'/.git` : ''}
${copies}
Then confirm each '${dirOf(it)}/${SKILLS}/<name>/SKILL.md' exists. Return ok, the installed skill names, and a note listing anything that failed.`,
      { label: `setup:${labelOf(it)}`, phase: 'Run', schema: SETUP, model: 'sonnet' })
  },
  (setup, it) => setup.ok ? agent(`${args.prompt}

The project is at ${dirOf(it)}; work there, starting with \`cd ${dirOf(it)}\`. Its conventions are in ${dirOf(it)}/${SKILLS}.`,
    { label: labelOf(it), phase: 'Run', model: MODEL }) : null,
  (out, it) => agent(`Read-only. Find pi session files that ran in '${dirOf(it)}': \`rg -l -F '${dirOf(it)}' ~/.pi/agent/sessions\` (also try the newest files in the sibling directory of $PI_SESSION_FILE if none). For each, list what it read with:
jq -r 'select(.type=="message") | .message.content[]? | select(.type=="toolCall") | .name + " " + (.arguments | tostring)' <file>
Return session paths, the distinct file paths read or opened by shell commands (cat, rg, sed, jq on a path), and skillsOpened = true only if any path is under ${SKILLS}/ .`,
    { label: `reads:${labelOf(it)}`, phase: 'Run', type: 'explore', schema: READS }).then((r) => ({ out, reads: r })),
)

const done = items.map((it, i) => ({ it, r: results[i] })).filter((x) => x.r)
log(`${done.length}/${items.length} candidates finished`)
phase('Judge')
const SCORES = {
  type: 'object', required: ['scores'], properties: { scores: { type: 'array', items: {
    type: 'object', required: ['label', 'criteria', 'reason'], properties: {
      label: { type: 'string' },
      criteria: { type: 'array', items: { type: 'object', required: ['criterion', 'score'], properties: { criterion: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 5 } } } },
      reason: { type: 'string' } } } } },
}
const shown = done.map((x) => `=== ${labelOf(x.it)} ===\n${x.r.out}`).join('\n\n')
const judged = await agent(`You are read-only: edit nothing. Score each piece of work below against the criteria, 0-5 per criterion, on one scale across all of them, in one pass. You do not know how any was produced. Judge the final text, and you may read files under the listed project dirs, but ignore their ${SKILLS} folders.
Criteria:
${args.rubric.map((c, i) => `${i + 1}. ${c}`).join('\n')}
Dirs: ${done.map((x) => `${labelOf(x.it)}=${dirOf(x.it)}`).join(', ')}

${shown}

Return one entry per label with a score per criterion and a one-line reason.`,
  { label: 'judge', phase: 'Judge', type: 'design-review', thinking: 'medium', schema: SCORES })

const byLabel = Object.fromEntries((judged?.scores ?? []).map((s) => [s.label, s]))
return {
  table: items.map((it, i) => ({
    label: labelOf(it),
    variant: it.v.label,
    scores: byLabel[labelOf(it)]?.criteria ?? null,
    skillsOpened: results[i]?.reads?.skillsOpened ?? null,
    filesRead: results[i]?.reads?.reads ?? null,
    reason: byLabel[labelOf(it)]?.reason ?? null,
  })),
  outputs: Object.fromEntries(done.map((x) => [labelOf(x.it), x.r.out])),
  sessions: Object.fromEntries(done.map((x) => [labelOf(x.it), x.r.reads?.sessions ?? []])),
}
