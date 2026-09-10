# .ai — agent memory

Machine-readable memory for AI agents working in this repo. Read the relevant
parts before planning; write to it at the end of every session.

## Layout

- `.ai/sessions/<topic>/YYYY-MM-DD-HHMM--slug.md` — one file per local session.
  AI work history: what was done, what is unfinished, what was tried/rejected,
  decision moments, verification results. One new file per session; never append
  to a previous session's file.
- `.ai/decisions/<topic>/YYYY-MM-DD--slug.md` — organizational decision history:
  the "why", high-level project logic, constraint choices. Never code detail.

Both are organized as one level of topic folders; reuse an existing topic folder
when one matches, create a new one only when nothing fits.

## Topic index (sessions)

| Topic | Scope |
|-------|-------|
| `project-init` | repo bootstrap, conventions |
| `gateway` | gateway service: express, proxy, auth, model lifecycle, control-center v2 legacy |
| `analytics` | analytics service: ingest, EWMA/PCA, NN training, warehouse, ML UI rounds |
| `model-runtime` | llama.cpp runtime, model-as-data, host scripts |
| `ui-refactor` | React + Vite + Tailwind control-center SPA (`ui/`), swap, regressions |

## Rules of thumb

- **Read first:** for a task, browse the relevant topic folders — decisions, then
  sessions — before planning or coding. Load only what's relevant.
- **Record the moment a decision is confirmed**, not at the end of the day.
- **Never hallucinate memory**: if a fact isn't in memory, a plan, or code, ask.
- Full workflow in the `repo-memory` skill (`.claude/skills/repo-memory/SKILL.md`).