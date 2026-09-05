---
name: repo-memory
description: Read and update this repo's session memory (.ai/sessions/) and organizational decision history (.ai/decisions/). Use at the start of EVERY session to load context, whenever the user confirms a decision, and before ending a session to record work history. Triggers: starting any task in this repo, "why was this done", "what did we decide", "record this decision", finishing a work session.
---

# Repo Memory

This repo keeps its AI memory in `.ai/`:

- `.ai/sessions/` — AI work history: what was done, when, and what's open.
- `.ai/decisions/` — organizational decision history: the **why** behind changes.

Both use one level of topic folders with one file per session inside. See the README in each folder for the file templates.

## At session start (always)

1. Identify the topic(s) the task touches.
2. List folders in `.ai/decisions/` and `.ai/sessions/`. Read files in matching topic folders — decisions first (the why), then the 2–3 most recent session files (the recent history). Skim filenames; timestamps and feature summaries are in the names for exactly this reason.
3. Do not load unrelated topics. Keep context lean.
4. Create the session file for this session **now**:
   `.ai/sessions/<topic>/<YYYY-MM-DD-HHmm>--<feature-summary>.md`
   - Get the real timestamp from the system (`date +%Y-%m-%d-%H%M`) — never guess it.
   - `<feature-summary>` = 4–5 words, lowercase, hyphenated, describing the feature being worked on.
   - **New session = new file, always.** Never append to a previous session's file, even for the same feature.
   - Reuse an existing topic folder if one reasonably matches (check for near-duplicates like `auth` vs `authentication` before creating a new folder).

## During the session

- Update the session file as significant work lands: what was done, notable findings, approaches rejected and why.
- The moment the user confirms a decision, write it to
  `.ai/decisions/<topic>/<YYYY-MM-DD>--<short-decision-title>.md` using the template in `.ai/decisions/README.md`.
  - If a decision file for this session and topic already exists, append the new decision to that same file (one file per session per topic).
  - Decision language only. The what and the why — no code detail.
  - Only confirmed decisions. Never record the agent's own assumptions as decisions.
  - Append-only history: never edit or delete past decision files. A reversal is a new file referencing the old one.

## Before the session ends

1. Finalize the session file: request, what was done, key files/modules touched, open threads.
2. Confirm every user-confirmed decision from this session has a decision file entry.

## Multi-repo projects

When running from a root project directory containing several repos (frontend, backend, super-admin, etc.):

- Write memory into the `.ai/` of the repo the work belongs to.
- Work spanning repos → one session file **per affected repo**, each covering that repo's part.
- A decision goes in the repo it primarily governs; if it genuinely spans repos, record it in each affected repo.
- Never write memory files at the root level.

## Answering "why" questions

When the user asks why something works the way it does, or what was decided historically: search `.ai/decisions/` (folder and file names first, then contents) before reading code or answering from general knowledge. If the answer isn't in decisions, sessions, or code — say so and ask; never invent history.
