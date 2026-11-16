#!/usr/bin/env node
// agent-receipt: what your coding agent claimed, against what its own log shows.
//
//   receipt                     the latest Claude Code session for this folder
//   receipt --codex             the latest Codex session
//   receipt path/to/log.jsonl   a specific session log
//   --all      the whole session, not just the last request
//   --md       Markdown, ready to paste into a pull request
//   --html F   write a shareable HTML receipt to F
//   --json     the raw receipt
//   --hook     run as a Claude Code Stop hook (reads the hook's JSON on stdin)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFile } from '../src/parse.js'
import { analyze } from '../src/analyze.js'
import { terminal, markdown, html } from '../src/render.js'

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const value = (f) => { const k = args.indexOf(f); return k >= 0 ? args[k + 1] : null }

if (flag('-h') || flag('--help')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}

function newest(files) {
  return files.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}
function latestClaude(cwd) {
  const root = path.join(os.homedir(), '.claude', 'projects')
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const here = path.join(root, slug)
  const files = fs.existsSync(here) ? fs.readdirSync(here).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(here, f)) : []
  return newest(files.length ? files : walk(root))
}
const latestCodex = () => newest(walk(path.join(os.homedir(), '.codex', 'sessions')))

let file = args.find((a) => a.endsWith('.jsonl'))
let hook = null
if (flag('--hook')) {
  try { hook = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { hook = {} }
  file = hook.transcript_path || file
}
if (!file) file = flag('--codex') ? latestCodex() : latestClaude(process.cwd())
if (!file || !fs.existsSync(file)) {
  console.error('receipt: no session log found. Pass a .jsonl path, or run it in a folder where you used Claude Code (or add --codex).')
  process.exit(2)
}

const { format, events } = parseFile(file)
const r = analyze(events, { all: flag('--all') })
const meta = { agent: format === 'codex' ? 'Codex' : 'Claude Code', session: path.basename(file, '.jsonl').slice(-8) }

if (flag('--json')) console.log(JSON.stringify({ ...meta, ...r }, null, 2))
else if (flag('--md')) console.log(markdown(r, meta))
else if (hook) {
  // A Stop hook: keep a Markdown receipt beside the work, and say one line.
  const dir = path.join(hook.cwd || process.cwd(), '.receipts')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${meta.session}.md`)
  fs.writeFileSync(out, markdown(r, meta) + '\n')
  console.error(`receipt: ${r.verdict.text} → ${path.relative(hook.cwd || process.cwd(), out)}`)
} else console.log(terminal(r, meta))

const htmlOut = value('--html')
if (htmlOut) { fs.writeFileSync(htmlOut, html(r, meta)); console.error(`receipt: wrote ${htmlOut}`) }

process.exit(0)
