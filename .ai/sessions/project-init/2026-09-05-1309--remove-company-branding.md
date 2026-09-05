# Remove origin-company branding, organization-neutral wording

- **Date:** 2026-09-05 13:09
- **Developer:** opencode
- **Topic:** project-init

## Request

Remove the origin company's branding from the agent-rules content across this repo, and
reword anything that referenced company/business standards (e.g. "Company-wide standards",
"all company repos") so it references the organization instead — the rules must read as
neutral organization standards, not material copied from one company.

## What was done

Branding scrubbed from all presented/live content:

- `rules-site/index.html` — `<title>`, titlebar, hero comment + the `require(...)` module
  string, statusbar item, breadcrumb crumbs (dropped the origin-company module segment), and
  the embedded `DOCS` markdown:
  - "Mandatory Agent Rules — <origin>" → "Mandatory Agent Rules"
  - "Company-wide standards for the <origin> stack: TypeScript…" → "Organization-wide
    standards: TypeScript…"
  - removed the origin-branded logo image + "<origin> — Agent Setup for Projects" heading →
    "# Agent Rules — Project Setup"
  - "for all company repos" → "for all organization repos"
- `AGENTS.md` / `AGENTS.flutter.md` — the two "<origin> stack" standards lines →
  "Organization-wide standards"; also converted the shared "business decision history / the
  business why / business decisions" memory wording to organizational/decision language.
- `.claude/skills/repo-memory/SKILL.md` — same memory wording converted ("organizational
  decision history", "confirms a decision", "Decision language only").
- `.ai/decisions/README.md` — "# Business Decision History" → "# Organizational Decision
  History", "plain business language" → "plain language", "business context" → "organizational
  context".
- Historical note in a past session file rewrote to say "copy of the agent-rules template"
  (no origin reference).

Engineering terms untouched on purpose: "business logic", "config-defined business flows".

## Verification

- Case-insensitive search for the origin brand → 0 hits across the repo (including file
  names and this record).
- `grep -rni company` → 0 in presented content; only literal changed-string references remain
  in this record. "Business"-identity phrasing → 0.

## Open threads

- Repo is not yet a git repository; user will initialize/commit/push and run the host
  `scripts/install.sh` test themselves.
- llama runtime provisioning + live acceptance remain the pending next step (see the
  `model-runtime` sessions).