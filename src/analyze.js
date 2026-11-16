// Read a run's events and write the receipt: what the agent claimed, what the
// log shows actually happened, and what is left for a person.
//
// Each claim in the agent's closing summary gets one of four states:
//   observed     the log shows it happening, after the last change
//   stale        it happened, but files changed after it, so it no longer proves the end state
//   contradicted the log shows it failing (non-zero exit, failed tests, nothing ran)
//   asserted     the agent said it, and nothing in the log backs it up

export const KINDS = {
  test: /\b(vitest|jest|pytest|mocha|playwright test|cypress run|go test|cargo test|rspec|phpunit|bun test|node --test|(npm|pnpm|yarn) (run )?test)\b/,
  build: /\b(tsc|next build|vite build|cargo build|go build|go vet|eslint|mypy|ruff|(npm|pnpm|yarn) (run )?(build|typecheck|type-check|lint|check))\b/,
  deploy: /\b(vercel( deploy| --prod)|vercel$|fly deploy|netlify deploy|wrangler deploy|kubectl apply|terraform apply|firebase deploy)\b/,
  push: /\bgit push\b/,
  commit: /\bgit commit\b/,
  db: /\b(psql|supabase (db|migration)|prisma (migrate|db push)|drizzle-kit (push|migrate)|knex migrate|rails db:migrate|alembic upgrade|npm run db:)/,
}

const CLAIMS = [
  { kind: 'test', re: /\b(tests?|suites?|specs?)\b[^.]*\b(pass(es|ed|ing)?|green|clean|succeed(s|ed)?)\b|\ball\b[^.]*\bpass(es|ed|ing)?\b/i },
  { kind: 'build', re: /\b(build|builds|type-?check|types|lint|compiles?)\b[^.]*\b(clean|pass(es|ed)?|succeed(s|ed)?|green|ok|no errors)\b/i },
  { kind: 'deploy', re: /\b(deployed|is live|now live|in production|shipped to prod)/i },
  { kind: 'push', re: /\bpushed\b/i },
  { kind: 'commit', re: /\bcommitted\b/i },
  { kind: 'db', re: /\b(migrations?|schema|database|table|column)s?\b[^.]*\b(applied|migrated|updated|created|added)\b/i },
  { kind: 'verify', re: /\b(verified|confirmed|works|working|fixed|resolved|implemented|applied|addressed|done|completed?|finished)\b/i },
]

// "Not committed", "didn't run the tests", "haven't deployed": an honest gap, not a claim.
const NEGATED = /\b(not|n't|never|without|haven't|hasn't|didn't|wasn't|isn't|aren't|weren't|can't|couldn't|blocked|skipped|untested|unverified)\b[^.]{0,40}\b(commit|push|deploy|test|run|appl|verif|build|check|live|repeat|re-?ran|rerun)/i

// Sentences that tell the reader what to do are not claims about what was done.
const INSTRUCTION = /^(try|open|run|go|check|tap|click|visit|install|add|use|see|read)\b/i

// Files a person should look at whatever the logs say.
const RISKY = [
  [/migrations?\//i, 'a database migration'],
  [/(^|\/)\.env/i, 'environment secrets'],
  [/(stripe|payment|billing|checkout|webhook)/i, 'money or webhooks'],
  [/(auth|session|permission|middleware)/i, 'sign-in or access'],
  [/\.github\/workflows|Dockerfile|terraform|vercel\.(json|ts)/i, 'deploy configuration'],
  [/(^|\/)package\.json$|lock(file)?(\.json|\.yaml)?$/i, 'dependencies'],
]

export function classify(cmd) {
  for (const [kind, re] of Object.entries(KINDS)) if (re.test(cmd)) return kind
  return null
}

// What the test output itself says, whatever the exit code claims.
export function readTestOutput(output) {
  const s = output || ''
  const pick = (re) => { const m = s.match(re); return m ? Number(m[1]) : null }
  const passed = pick(/Tests?:?\s+(?:\d+ failed[, |]+)?(\d+) passed/i) ?? pick(/(\d+) passed/i) ?? pick(/# pass (\d+)/)
  const failed = pick(/(\d+) failed/i) ?? pick(/# fail (\d+)/) ?? (/\bFAIL\b/.test(s) ? 1 : null)
  const noTests = /no tests? (found|ran|were found)|0 tests?\b|No test files found/i.test(s)
  return { passed, failed, noTests }
}

export function scope(events, { all = false } = {}) {
  if (all) return events
  let start = 0
  events.forEach((e, k) => { if (e.kind === 'user') start = k })
  return events.slice(start)
}

export function analyze(events, opts = {}) {
  const run = scope(events, opts)
  const commands = run.filter((e) => e.kind === 'command' && e.cmd)
  const edits = run.filter((e) => e.kind === 'edit')
  const lastEdit = edits.length ? edits[edits.length - 1].i : -1
  const editsAfter = (i) => edits.filter((e) => e.i > i)

  // Every meaningful command becomes a piece of evidence.
  const evidence = []
  for (const c of commands) {
    const kind = classify(c.cmd)
    if (!kind) continue
    const ev = { kind, cmd: c.cmd.trim(), i: c.i, exit: c.exit, ok: c.ok, notes: [] }
    if (kind === 'test') {
      const r = readTestOutput(c.output)
      ev.tests = r
      if (r.failed > 0) ev.ok = false
      if (r.noTests || r.passed === 0) { ev.ok = false; ev.notes.push('no tests actually ran') }
      if (/\|\s*(tail|head|grep|tee|less)\b/.test(c.cmd) && r.failed == null && r.passed == null) {
        ev.notes.push('output was cut by a pipe, so the result could not be read')
        ev.weak = true
      }
    }
    if (c.ok == null) { ev.ok = false; ev.notes.push('the command never finished') }
    const later = editsAfter(c.i)
    ev.stale = later.length > 0
    ev.staleBy = [...new Set(later.map((e) => short(e.file)))]
    evidence.push(ev)
  }

  // The closing summary, one sentence at a time.
  const finalSay = [...run].reverse().find((e) => e.kind === 'say' && e.final)
  const summary = finalSay ? finalSay.text : ''
  const claims = []
  const disclosed = [] // gaps the agent admitted to itself, e.g. "not committed"
  for (const sentence of sentences(summary)) {
    if (NEGATED.test(sentence)) { disclosed.push(sentence); continue }
    if (INSTRUCTION.test(sentence) || /^!?\[/.test(sentence)) continue // advice to the reader, or a link
    const match = CLAIMS.find((c) => c.re.test(sentence))
    if (!match) continue
    if (match.kind === 'verify' && !edits.length) continue // nothing changed, so nothing to vouch for
    claims.push(judge(sentence, match.kind, evidence, commands, lastEdit))
  }

  // Test output pasted into the summary as proof: which run did it come from?
  for (const block of summary.match(/```[\s\S]*?```/g) || []) {
    const shown = readTestOutput(block)
    if (shown.passed == null) continue
    const source = [...evidence].reverse().find((e) => e.kind === 'test' && e.tests && e.tests.passed === shown.passed)
    const text = `Pasted proof: ${shown.passed} tests passed`
    if (!source) claims.push({ text, kind: 'test', state: 'asserted', evidence: null, why: 'no run in the log printed this result' })
    else if (source.stale) claims.push({ text, kind: 'test', state: 'stale', evidence: source, why: staleWhy(source) })
    else claims.push({ text, kind: 'test', state: 'observed', evidence: source, why: `matches ${source.cmd}` })
  }

  // Failures the agent moved on from without ever getting a pass.
  const unresolved = []
  for (const ev of evidence) {
    if (ev.ok) continue
    const fixedLater = evidence.some((o) => o.kind === ev.kind && o.i > ev.i && o.ok)
    if (!fixedLater) unresolved.push(ev)
  }

  const changed = [...new Set(edits.map((e) => e.file))]
  const risky = []
  for (const f of changed) {
    const hit = RISKY.find(([re]) => re.test(f))
    if (hit) risky.push({ file: short(f), why: hit[1] })
  }

  const forYou = []
  for (const c of claims) {
    if (c.state === 'asserted') forYou.push({ what: `Check: “${c.text}”`, why: 'nothing in the run shows it' })
    if (c.state === 'contradicted') forYou.push({ what: `Look at: “${c.text}”`, why: c.why })
    if (c.state === 'stale') forYou.push({ what: `Re-run: ${c.evidence.cmd}`, why: c.why })
  }
  for (const d of disclosed) forYou.push({ what: `Agent flagged: “${d}”`, why: 'it said this was not done' })
  for (const r of risky) forYou.push({ what: `Review ${r.file}`, why: `it touches ${r.why}` })
  for (const u of unresolved) {
    if (!claims.some((c) => c.evidence === u)) forYou.push({ what: `Failed and never passed: ${u.cmd}`, why: describe(u) })
  }
  const codeChanged = changed.some((f) => /\.(m?[jt]sx?|py|go|rs|rb|php|java|kt|swift|css|sql)$/.test(f))
  if (codeChanged && !evidence.some((e) => e.kind === 'test')) {
    forYou.push({ what: 'No tests ran in this run', why: `${changed.length} file${changed.length === 1 ? '' : 's'} changed` })
  }

  const seen = new Set()
  const uniqueForYou = forYou.filter((f) => !seen.has(f.what) && seen.add(f.what))
  forYou.length = 0
  forYou.push(...uniqueForYou)

  const counts = { observed: 0, stale: 0, contradicted: 0, asserted: 0 }
  for (const c of claims) counts[c.state]++
  return {
    summary: firstLine(summary),
    claims,
    disclosed,
    evidence,
    changed: changed.map(short),
    commandsRun: commands.length,
    forYou,
    counts,
    verdict: verdictOf(counts, forYou),
  }
}

function judge(text, kind, evidence, commands, lastEdit) {
  const want = kind === 'verify' ? null : kind
  const pool = evidence.filter((e) => (want ? e.kind === want : true))
  if (kind === 'verify') {
    // "Fixed" or "works" is backed by a check that ran after the last change.
    const after = pool.filter((e) => e.i > lastEdit)
    const good = after.find((e) => e.ok)
    if (good) return { text, kind, state: 'observed', evidence: good, why: `${good.cmd} ran after the last change` }
    const bad = after.find((e) => !e.ok)
    if (bad) return { text, kind, state: 'contradicted', evidence: bad, why: describe(bad) }
    const before = [...pool].reverse().find((e) => e.ok)
    if (before) return { text, kind, state: 'stale', evidence: before, why: staleWhy(before) }
    return { text, kind, state: 'asserted', evidence: null, why: 'no check ran after the change' }
  }
  if (!pool.length) {
    return { text, kind, state: 'asserted', evidence: null, why: `no ${label(kind)} command ran in this run` }
  }
  const last = pool[pool.length - 1]
  if (!last.ok) return { text, kind, state: 'contradicted', evidence: last, why: describe(last) }
  if (last.stale && ['test', 'build'].includes(kind)) return { text, kind, state: 'stale', evidence: last, why: staleWhy(last) }
  return { text, kind, state: 'observed', evidence: last, why: describe(last) }
}

function describe(ev) {
  if (ev.notes.length) return ev.notes[0]
  if (ev.tests && (ev.tests.passed != null || ev.tests.failed != null)) {
    const p = ev.tests.passed ?? 0, f = ev.tests.failed ?? 0
    return f ? `${f} failed, ${p} passed` : `${p} passed`
  }
  return ev.ok ? 'exit 0' : `exit ${ev.exit ?? '?'}`
}

function staleWhy(ev) {
  const files = ev.staleBy.slice(0, 3).join(', ')
  const more = ev.staleBy.length > 3 ? ` and ${ev.staleBy.length - 3} more` : ''
  return `ran before later edits to ${files}${more}`
}

function verdictOf(counts, forYou) {
  if (counts.contradicted) return { tone: 'bad', text: `${counts.contradicted} claim${counts.contradicted > 1 ? 's' : ''} the log contradicts` }
  if (counts.stale) return { tone: 'warn', text: 'Proof is out of date: files changed after it ran' }
  if (counts.asserted) return { tone: 'warn', text: `${counts.asserted} claim${counts.asserted > 1 ? 's' : ''} with no proof in the run` }
  const total = counts.observed
  if (!total && forYou.length) return { tone: 'warn', text: 'No checkable claims, and a few things are still yours' }
  if (!total) return { tone: 'ok', text: 'The summary made no claims to check' }
  if (forYou.length) return { tone: 'ok', text: 'Claims match the log. A few things are still yours.' }
  return { tone: 'ok', text: 'Every claim matches what the log shows' }
}

const label = (k) => ({ test: 'test', build: 'build or type-check', deploy: 'deploy', push: 'git push', commit: 'git commit', db: 'database' }[k] || k)

export function sentences(text) {
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*/g, '')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`“"(*-])/)
    .map((s) => s.replace(/^[\s*>#\-•\d.)]+/, '').replace(/\*\*/g, '').trim())
    .filter((s) => s.length > 3)
}

const firstLine = (s) => (s || '').split('\n').map((x) => x.trim()).find(Boolean) || ''
export const short = (f) => (f || '').replace(/^.*?\/(?=(src|app|lib|components|pages|test|tests|supabase|scripts|docs)\/)/, '').replace(/^\/Users\/[^/]+\//, '~/')
