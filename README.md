# agent-receipt

**What your coding agent claimed, against what its own log shows.**

When Claude Code or Codex finishes, it writes a summary: *"Implemented. Tests pass."*
That summary is the agent describing itself. The log of what it actually ran is right
there on your disk. `agent-receipt` reads that log and checks the summary against it,
one sentence at a time.

```
  RECEIPT  Codex · 05eb8e3f
  Agent said: "Implemented exact trim-size output for pre-cut cards."
  ■ Proof is out of date: files changed after it ran

  CLAIMS
  ◐ Stale        "Implemented exact trim-size output for pre-cut cards."
    ↳ ran before later edits to scripts/card-print.mjs  ·  npx vitest run lib/cards scripts

  LEFT FOR YOU
  1. Re-run: npx vitest run lib/cards scripts  — ran before later edits to scripts/card-print.mjs

  3 files changed · 8 commands run · 3 counted as evidence
```

That is a real receipt, from a real Codex run. The tests passed, then the agent edited a
file, then it said it was done. Nothing was wrong with the summary's wording. The proof
was simply older than the code.

## Four states, one question each

| State | Means |
|---|---|
| ✓ **Observed** | The log shows it happening, after the last change. |
| ◐ **Stale** | It happened, but files changed afterwards, so it no longer proves the end state. |
| ✗ **Contradicted** | The log shows it failing: a non-zero exit, failed tests, or zero tests collected. |
| ? **Asserted** | The agent said it. Nothing in the run backs it up. |

Then **Left for you**: a short checklist built from the gaps, not written by the agent.
Unproven claims, stale proof to re-run, failures nobody came back to, things the agent
admitted it skipped ("not committed"), and files a person should look at regardless
(migrations, `.env`, payments, auth, deploy config, dependencies).

## Use

```bash
npx github:andrewprosdocimi/agent-receipt            # latest Claude Code session in this folder
npx github:andrewprosdocimi/agent-receipt --codex    # latest Codex session
receipt path/to/session.jsonl --md                   # Markdown for a pull request
receipt --html receipt.html                          # a shareable page
```

Only the last request in a session is judged; add `--all` for the whole session.
No dependencies. Nothing leaves your machine: it reads local log files and prints.

### Every time Claude Code stops

Add a Stop hook to `.claude/settings.json` and a receipt is written to `.receipts/` after
every run, with one line in your terminal:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y github:andrewprosdocimi/agent-receipt --hook" }] }] } }
```

### With Rocket Fuel

[Rocket Fuel](https://github.com/NulightJens/rocket-fuel-skill) by Jens Heitmann pairs a
planning-and-review agent with Codex as the builder. Its review step already refuses to
trust "the intern's demo". Run `receipt --codex` on the Integrator's run before the
Level 10 review, and the reviewer starts from the claims that lack proof instead of
re-reading everything.

## What it does not do

- It reads logs; it does not re-run anything. A receipt says what was *shown*, not what is *true*.
- Claim matching is plain pattern matching on the summary's sentences. It will miss some
  claims and occasionally flag a sentence that was not one. It errs toward asking.
- Commands an agent ran inside another tool (a browser, an MCP server) are not evidence yet.

## Why this exists

I built a gifting product, Cassioni, by directing coding agents. Most of the time their
"done" was true. The times it wasn't all looked the same: the agent reported what it saw,
and what it saw was someone else's self-report.

- A run of camera fixes, each finished and tested, trusted what the camera *said* it was
  sending. A real recording still came out cropped. The next fix started by measuring.
- A test passed because it asserted the wrong answer. Only a reviewer who re-ran
  everything caught it.
- Codex ran the tests, edited again, and pasted the earlier results under "Proof".
  This tool caught that one, months later, from the log alone.

A report is not evidence, and no error is not success. This is the check I wanted at the
end of every run.

MIT · Andrew Prosdocimi
