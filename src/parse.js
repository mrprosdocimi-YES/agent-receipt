// Turn an agent's session log into one ordered list of plain events.
// Two formats are understood: Claude Code transcripts and Codex rollouts.
//
// Every event has { kind, i } where i is its position in the run.
//   user     { text }                       a person asked for something
//   command  { cmd, ok, exit, output }      a shell command ran
//   edit     { file }                       a file was written or changed
//   read     { file }                       a file was opened
//   say      { text, final }                the agent said something

import fs from 'node:fs'

export function detectFormat(lines) {
  for (const line of lines.slice(0, 50)) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'session_meta' || d.payload) return 'codex'
    if (d.sessionId || d.message) return 'claude'
  }
  return 'claude'
}

export function parseFile(path) {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const format = detectFormat(lines)
  const events = format === 'codex' ? parseCodex(lines) : parseClaude(lines)
  return { format, events: events.map((e, i) => ({ ...e, i })) }
}

const asText = (c) => {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(asText).join('\n')
  if (typeof c === 'object') return asText(c.text ?? c.content ?? '')
  return String(c)
}

// ---------- Claude Code ----------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function parseClaude(lines) {
  const out = []
  const pending = new Map() // tool_use id -> partial event
  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.isSidechain) continue // a subagent's work is its own run
    const m = d.message
    if (!m || typeof m !== 'object') continue
    const content = m.content

    if (d.type === 'user') {
      if (typeof content === 'string') {
        if (!isHarnessNoise(content)) out.push({ kind: 'user', text: content, t: d.timestamp })
        continue
      }
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part.type === 'text' && !isHarnessNoise(part.text)) {
          out.push({ kind: 'user', text: part.text, t: d.timestamp })
        }
        if (part.type === 'tool_result') {
          const ev = pending.get(part.tool_use_id)
          if (!ev) continue
          pending.delete(part.tool_use_id)
          if (ev.kind !== 'command') continue
          const text = asText(part.content)
          const exitMatch = text.match(/^Exit code (\d+)/m)
          const exit = part.is_error ? (exitMatch ? Number(exitMatch[1]) : 1) : 0
          const tur = d.toolUseResult
          const output = typeof tur === 'object' && tur
            ? [tur.stdout, tur.stderr].filter(Boolean).join('\n') || text
            : text
          Object.assign(ev, { ok: exit === 0 && !(tur && tur.interrupted), exit, output })
        }
      }
      continue
    }

    if (d.type === 'assistant' && Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text' && part.text.trim()) {
          out.push({ kind: 'say', text: part.text, t: d.timestamp })
        }
        if (part.type !== 'tool_use') continue
        const input = part.input || {}
        if (part.name === 'Bash') {
          const ev = { kind: 'command', cmd: input.command || '', ok: null, exit: null, output: '', t: d.timestamp }
          out.push(ev)
          pending.set(part.id, ev)
        } else if (EDIT_TOOLS.has(part.name)) {
          out.push({ kind: 'edit', file: input.file_path || input.notebook_path || '?', t: d.timestamp })
        } else if (part.name === 'Read') {
          out.push({ kind: 'read', file: input.file_path || '?', t: d.timestamp })
        }
      }
    }
  }
  markFinal(out)
  return out
}

// Messages the harness injects are not a person asking for something.
function isHarnessNoise(text) {
  const s = (text || '').trim()
  return !s ||
    s.startsWith('<system-reminder') ||
    s.startsWith('<command-') ||
    s.startsWith('<local-command') ||
    s.startsWith('<task-notification') ||
    s.startsWith('Base directory for this skill') ||
    s.startsWith('[Request interrupted') ||
    s.startsWith('Caveat:')
}

// ---------- Codex ----------

export function parseCodex(lines) {
  const out = []
  for (const line of lines) {
    let d
    try { d = JSON.parse(line) } catch { continue }
    const p = d.payload
    if (!p || p.type !== 'item_completed' || !p.item) continue
    const it = p.item
    const t = d.timestamp
    if (it.type === 'UserMessage') {
      out.push({ kind: 'user', text: asText(it.content), t })
    } else if (it.type === 'AgentMessage') {
      out.push({ kind: 'say', text: asText(it.content), t, final: it.phase === 'final_answer' })
    } else if (it.type === 'CommandExecution') {
      const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : String(it.command || '')
      const exit = it.exit_code == null ? null : Number(it.exit_code)
      out.push({ kind: 'command', cmd, ok: exit === 0, exit, output: it.aggregated_output || it.stdout || '', t })
    } else if (it.type === 'FileChange') {
      for (const file of Object.keys(it.changes || {})) out.push({ kind: 'edit', file, t })
    }
  }
  markFinal(out)
  return out
}

// The agent's closing words: the last thing it said after its last action.
function markFinal(events) {
  if (events.some((e) => e.final)) return
  let lastAction = -1
  events.forEach((e, k) => { if (e.kind === 'command' || e.kind === 'edit') lastAction = k })
  for (let k = events.length - 1; k > lastAction; k--) {
    if (events[k].kind === 'say') { events[k].final = true; return }
    if (events[k].kind === 'user') return
  }
}
