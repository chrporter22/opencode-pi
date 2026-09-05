# Rules and templates are organization-neutral (no origin branding)

- **Date:** 2026-09-05
- **Decided by:** user
- **Topic:** project-init

## Decision

Remove all origin-company branding from the agent-rules content in this repo (rules-site
presentation, AGENTS templates, repo-memory skill), and reword passages that referenced
company/business standards ("Company-wide standards…", "all company repos", the origin-branded
"stack") so they reference the organization instead. The rules must read as generic
organization standards, not as material copied from one company.

## Why

The agent-rules template is meant to be adopted by the organization broadly. Wording that
still named the origin company or its "company-wide" framing looked copied from that source
and did not fit a neutral organization-wide rollout.

## Impact

- `rules-site/index.html`, `AGENTS.md`, `AGENTS.flutter.md`,
  `.claude/skills/repo-memory/SKILL.md`, `.ai/decisions/README.md`.

## Notes / relates to

- Deliberately retained engineering terms: "business logic", "config-defined business flows".
- History references to the origin were also scrubbed from session memory at the user's
  request so no copy/sibling-copy language about it remains.
- Follow-up on the sibling directory `/home/pi5_nvme/new-project-agent-rules/` was
  intentionally deferred and not part of this repo's commit.