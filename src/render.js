// Three ways to show a receipt: the terminal, Markdown (for a PR), and one HTML file.

const STATE = {
  observed: { mark: '✓', word: 'Observed', color: 32, hint: 'the log shows it' },
  stale: { mark: '◐', word: 'Stale', color: 33, hint: 'files changed after it ran' },
  contradicted: { mark: '✗', word: 'Contradicted', color: 31, hint: 'the log shows it failing' },
  asserted: { mark: '?', word: 'Asserted', color: 35, hint: 'said, never shown' },
}
const ORDER = ['contradicted', 'stale', 'asserted', 'observed']
const byState = (claims) => [...claims].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state))

export function terminal(r, meta = {}) {
  const color = !process.env.NO_COLOR && process.stdout.isTTY !== false
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  const dim = (s) => c(2, s), bold = (s) => c(1, s)
  const out = []
  const tone = { ok: 32, warn: 33, bad: 31 }[r.verdict.tone]
  out.push('')
  out.push(`  ${bold('RECEIPT')}  ${dim([meta.agent, meta.session].filter(Boolean).join(' · '))}`)
  if (r.summary) out.push(`  ${dim('Agent said:')} “${trim(r.summary, 90)}”`)
  out.push(`  ${c(tone, '■')} ${bold(r.verdict.text)}`)
  out.push('')
  if (r.claims.length) {
    out.push(`  ${bold('CLAIMS')}`)
    for (const cl of byState(r.claims)) {
      const s = STATE[cl.state]
      out.push(`  ${c(s.color, s.mark + ' ' + s.word.padEnd(12))} “${trim(cl.text, 70)}”`)
      out.push(`    ${dim('↳ ' + cl.why + (cl.evidence && !cl.why.includes(cl.evidence.cmd) ? '  ·  ' + trim(cl.evidence.cmd, 50) : ''))}`)
    }
    out.push('')
  } else {
    out.push(`  ${dim('The closing summary made no checkable claims.')}`)
    out.push('')
  }
  if (r.forYou.length) {
    out.push(`  ${bold('LEFT FOR YOU')}`)
    r.forYou.slice(0, 8).forEach((f, k) => out.push(`  ${k + 1}. ${trim(f.what, 80)}  ${dim('— ' + f.why)}`))
    if (r.forYou.length > 8) out.push(dim(`     and ${r.forYou.length - 8} more`))
    out.push('')
  }
  out.push(dim(`  ${r.changed.length} file${r.changed.length === 1 ? '' : 's'} changed · ${r.commandsRun} commands run · ${r.evidence.length} counted as evidence`))
  out.push('')
  return out.join('\n')
}

export function markdown(r, meta = {}) {
  const out = []
  out.push(`### Receipt${meta.agent ? ` · ${meta.agent}` : ''}`)
  if (r.summary) out.push(`> Agent said: “${r.summary}”`)
  out.push('', `**${r.verdict.text}**`, '')
  if (r.claims.length) {
    out.push('| | Claim | What the log shows |', '|---|---|---|')
    for (const cl of byState(r.claims)) {
      const s = STATE[cl.state]
      const ev = cl.evidence ? ` · \`${trim(cl.evidence.cmd, 60).replace(/\|/g, '\\|')}\`` : ''
      out.push(`| ${s.mark} ${s.word} | ${cl.text.replace(/\|/g, '\\|')} | ${cl.why}${ev} |`)
    }
    out.push('')
  }
  if (r.forYou.length) {
    out.push('**Left for you**', '')
    r.forYou.forEach((f) => out.push(`- [ ] ${f.what} — ${f.why}`))
    out.push('')
  }
  out.push(`<sub>${r.changed.length} files changed · ${r.commandsRun} commands run · made by agent-receipt</sub>`)
  return out.join('\n')
}

export function html(r, meta = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  const rows = byState(r.claims).map((cl) => `
    <li class="claim ${cl.state}">
      <span class="pill">${STATE[cl.state].mark} ${STATE[cl.state].word}</span>
      <div><p class="said">“${esc(cl.text)}”</p>
      <p class="why">${esc(cl.why)}${cl.evidence ? ` <code>${esc(trim(cl.evidence.cmd, 80))}</code>` : ''}</p></div>
    </li>`).join('')
  const todo = r.forYou.map((f) => `<li><label><input type="checkbox"> <span>${esc(f.what)}</span></label><small>${esc(f.why)}</small></li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent receipt</title><style>
:root{--bg:#121212;--card:#1b1a18;--line:#3a3935;--text:#f3f0e8;--dim:#a19d94;--ok:#5bc46a;--warn:#e0b04a;--bad:#ef6a5e;--ask:#cbb0f7}
@media (prefers-color-scheme: light){:root{--bg:#f7f5f0;--card:#fff;--line:#e2ded5;--text:#1c1b19;--dim:#6b675f;--ok:#22863a;--warn:#9a6a00;--bad:#c4372b;--ask:#6b46c1}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;padding:32px 16px}
main{max-width:760px;margin:auto}h1{font-size:13px;letter-spacing:.12em;color:var(--dim);margin:0 0 6px}
.said-top{color:var(--dim);margin:0 0 16px}.verdict{font-size:20px;font-weight:600;margin:0 0 24px}
.verdict.ok{color:var(--ok)}.verdict.warn{color:var(--warn)}.verdict.bad{color:var(--bad)}
ul{list-style:none;margin:0;padding:0}.claim{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:8px}
.pill{flex:none;font:12px ui-monospace,monospace;padding:3px 8px;border-radius:99px;border:1px solid currentColor;height:fit-content;min-width:118px}
.observed .pill{color:var(--ok)}.stale .pill{color:var(--warn)}.contradicted .pill{color:var(--bad)}.asserted .pill{color:var(--ask)}
.said,.why{margin:0}.why{color:var(--dim);font-size:13px}code{font:12px ui-monospace,monospace;background:var(--bg);padding:1px 5px;border-radius:4px}
h2{font-size:13px;letter-spacing:.12em;color:var(--dim);margin:28px 0 10px}.todo li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:6px}
.todo small{display:block;color:var(--dim);margin-left:24px}footer{color:var(--dim);font-size:12px;margin-top:24px}
</style></head><body><main>
<h1>RECEIPT${meta.agent ? ' · ' + esc(meta.agent).toUpperCase() : ''}</h1>
${r.summary ? `<p class="said-top">Agent said: “${esc(r.summary)}”</p>` : ''}
<p class="verdict ${r.verdict.tone}">${esc(r.verdict.text)}</p>
<ul>${rows || '<li class="claim"><p class="why">The closing summary made no checkable claims.</p></li>'}</ul>
${todo ? `<h2>LEFT FOR YOU</h2><ul class="todo">${todo}</ul>` : ''}
<footer>${r.changed.length} files changed · ${r.commandsRun} commands run · ${r.evidence.length} counted as evidence</footer>
</main></body></html>`
}

function trim(s, n) {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
