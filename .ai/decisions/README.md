# Organizational Decision History

High-level decisions and project logic for this repo. The purpose is the **why**: so future AI agents and humans understand why a change was made, can discuss it, and can answer questions from it.

This is not a technical changelog. Code detail lives in git history and session memory.

## Structure

```
.ai/decisions/<topic>/<YYYY-MM-DD>--<short-decision-title>.md
```

- `<topic>` — one level of folders, one per feature area (e.g. `pricing/`, `auth/`, `notifications/`). Reuse an existing folder if one matches; create a new one only if nothing fits. Lowercase, hyphenated.
- One file per working session per topic. Multiple decisions confirmed in the same session on the same topic go in the same file. This keeps git conflicts near zero when several developers work in parallel.

Example: `.ai/decisions/pricing/2026-07-06--annual-plan-discount-change.md`

## Rules

- **Append-only history.** Never edit or delete past decision files. If a decision is reversed, write a new file that references the old one.
- Record only user/stakeholder-confirmed decisions — never the agent's own assumptions.
- Record the decision the moment it is confirmed, not at session end.

## File template

```markdown
# <Short decision title>

- **Date:** YYYY-MM-DD
- **Decided by:** <who confirmed it>
- **Topic:** <topic folder>

## Decision
What was decided, in plain language.

## Why
The reasoning: organizational context, constraints, trade-offs considered.

## Supersedes / relates to
Links to earlier decision files this changes or builds on, if any.
```
