# Session Memory

AI work history for this repo. One file per local session — this is how future agents (and humans) find out what was done, why, and what's still open.

## Structure

```
.ai/sessions/<topic>/<YYYY-MM-DD-HHmm>--<feature-summary>.md
```

- `<topic>` — one level of folders, one per feature area (e.g. `auth/`, `billing/`, `onboarding/`). Reuse an existing folder if one matches; create a new one only if nothing fits. Lowercase, hyphenated.
- `<feature-summary>` — 4–5 words describing what the session worked on, lowercase, hyphenated.

Example: `.ai/sessions/billing/2026-07-06-1430--add-invoice-pdf-export.md`

## Rules

- **New session = new file.** Never append to a previous session's file, even for the same feature.
- One file per session per repo. If a session touches multiple repos, each repo gets its own file covering its part.
- Write during the session, finalize before it ends.

## File template

```markdown
# <Feature summary>

- **Date:** YYYY-MM-DD HH:mm
- **Developer:** <name>
- **Topic:** <topic folder>

## Request
What the user asked for, in one or two sentences.

## What was done
What changed, at the level of features and behavior. Mention key files/modules touched.

## Notable findings
Non-obvious things discovered about the codebase. Approaches tried and rejected, and why.

## Open threads
Unfinished work, known risks, follow-ups.
```
