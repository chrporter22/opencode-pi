# Restart button visible feedback + status-bar llama chip fix

- **Date:** 2026-09-06
- **Decided by:** user
- **Topic:** gateway

## Decision

The Control Center "Restart model" button (`gateway/public/index.html`) must give clear
visible feedback during the in-flight restart (button spinner + "Restarting…" label, a
status line in the Model card, and the top status dot turning yellow/amber), resolving
only when llama reports `ready` via polling or SSE — not silently at HTTP 200 return.
Additionally, the bottom status-bar llama chip must map real backend statuses (`ready` /
`starting` / `restarting` / `error` / `stopped`) instead of comparing against the
never-matched `"online"` value that caused it to always show "offline".

## Why

The backend restart path (`POST /api/model/restart` → `llamaSupervisor.restart()`) was
already correct and robust (commit `cdf9044` + `test/llama-restart.test.ts`), but the
frontend gave no visible in-flight feedback — only a transient line written to a hidden
`pre#modelLog` — so the restart appeared to do nothing (same model, same UI state when it
came back). Separately, `renderStatusbar()` compared `state.llama === "online"`, a value
the backend never emits, so the bottom status bar always showed the llama chip as
"offline".

## Supersedes / relates to

Relates to `2026-09-06-1900--model-swap-q4km-plan.md` (same topic: model restart
visibility around control plane actions); builds on the backend supervisor robustness in
commit `cdf9044`.
