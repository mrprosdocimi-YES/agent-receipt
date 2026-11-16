import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, readTestOutput, sentences, classify } from '../src/analyze.js'
import { parseClaude, parseCodex } from '../src/parse.js'

const run = (...evs) => evs.map((e, i) => ({ ...e, i }))
const user = (text = 'do it') => ({ kind: 'user', text })
const edit = (file) => ({ kind: 'edit', file })
const cmd = (c, ok = true, output = '') => ({ kind: 'command', cmd: c, ok, exit: ok ? 0 : 1, output })
const done = (text) => ({ kind: 'say', text, final: true })
const state = (r) => r.claims.map((c) => c.state)

test('a test run after the last edit makes "tests pass" observed', () => {
  const r = analyze(run(user(), edit('src/a.ts'), cmd('npx vitest run', true, 'Tests  12 passed (12)'), done('All tests pass.')))
  assert.deepEqual(state(r), ['observed'])
  assert.equal(r.verdict.tone, 'ok')
})

test('an edit after the test run makes the proof stale', () => {
  const r = analyze(run(user(), edit('src/a.ts'), cmd('npm test', true, '5 passed'), edit('src/b.ts'), done('Tests pass.')))
  assert.deepEqual(state(r), ['stale'])
  assert.match(r.claims[0].why, /src\/b\.ts/)
  assert.ok(r.forYou.some((f) => f.what.startsWith('Re-run')))
})

test('failed tests contradict the claim even when the exit code was 0', () => {
  const r = analyze(run(user(), edit('a.py'), cmd('pytest | tail -3', true, '2 failed, 9 passed in 1.2s'), done('Tests are green.')))
  assert.deepEqual(state(r), ['contradicted'])
  assert.match(r.claims[0].why, /2 failed/)
})

test('zero tests collected is not a pass', () => {
  const r = analyze(run(user(), edit('a.ts'), cmd('npx vitest run nothing', true, 'No test files found, exiting with code 0'), done('Tests pass.')))
  assert.deepEqual(state(r), ['contradicted'])
})

test('a claim with no matching command is asserted', () => {
  const r = analyze(run(user(), edit('supabase/migrations/052.sql'), done('The migration is applied to the database.')))
  assert.deepEqual(state(r), ['asserted'])
  assert.ok(r.forYou.some((f) => /migration/.test(f.why)))
})

test('"not committed" is a disclosed gap, not a claim', () => {
  const r = analyze(run(user(), edit('a.ts'), cmd('npm test', true, '3 passed'), done('Tests pass.\nThe change is not committed yet.')))
  assert.deepEqual(state(r), ['observed'])
  assert.equal(r.disclosed.length, 1)
})

test('only the last request is judged unless --all', () => {
  const evs = run(user('first'), cmd('npm test', false, '1 failed'), user('second'), edit('a.ts'), cmd('npm test', true, '4 passed'), done('Tests pass.'))
  assert.deepEqual(state(analyze(evs)), ['observed'])
  assert.equal(analyze(evs, { all: true }).evidence.length, 2)
})

test('code changed with no tests at all is left for the person', () => {
  const r = analyze(run(user(), edit('app/page.tsx'), done('Updated the page.')))
  assert.ok(r.forYou.some((f) => f.what === 'No tests ran in this run'))
})

test('reads the common test runners', () => {
  assert.deepEqual(readTestOutput('Tests  2393 passed | 7 skipped (2400)').passed, 2393)
  assert.deepEqual(readTestOutput('Tests: 1 failed, 5 passed, 6 total').failed, 1)
  assert.deepEqual(readTestOutput('# pass 8\n# fail 0').passed, 8)
  assert.equal(classify('git push origin main'), 'push')
  assert.equal(classify('ls -la'), null)
})

test('splits a summary into sentences and strips markdown', () => {
  assert.deepEqual(sentences('**Done.** Tests pass.\n- Build is clean'), ['Done.', 'Tests pass.', 'Build is clean'])
})

test('parses a Claude Code transcript', () => {
  const lines = [
    { type: 'user', message: { content: 'fix it' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/x/a.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 1\n1 failed' }] }, toolUseResult: { stdout: '1 failed', stderr: '' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed, tests pass.' }] } },
  ].map((o) => JSON.stringify(o))
  const evs = parseClaude(lines).map((e, i) => ({ ...e, i }))
  assert.deepEqual(evs.map((e) => e.kind), ['user', 'edit', 'command', 'say'])
  assert.equal(evs[2].exit, 1)
  assert.equal(analyze(evs).verdict.tone, 'bad')
})

test('parses a Codex rollout', () => {
  const item = (it) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: it } })
  const lines = [
    item({ type: 'UserMessage', content: [{ type: 'text', text: 'build it' }] }),
    item({ type: 'FileChange', changes: { '/r/lib/a.ts': { type: 'add' } } }),
    item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npx vitest run'], exit_code: 0, aggregated_output: 'Tests 3 passed' }),
    item({ type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Implemented. Tests pass.' }] }),
  ]
  const r = analyze(parseCodex(lines).map((e, i) => ({ ...e, i })))
  assert.deepEqual(state(r), ['observed', 'observed'])
})

test('test output pasted into the summary is traced to the run it came from', () => {
  const r = analyze(run(user(), edit('a.ts'), cmd('npx vitest run', true, 'Tests  29 passed (29)'), edit('b.mjs'),
    done('Implemented it.\n\nProof:\n```\nTests  29 passed (29)\n```\nThe full proof command was not repeated.')))
  const pasted = r.claims.find((c) => c.text.startsWith('Pasted proof'))
  assert.equal(pasted.state, 'stale')
  assert.equal(r.disclosed.length, 1)
  assert.equal(new Set(r.forYou.map((f) => f.what)).size, r.forYou.length)
})
