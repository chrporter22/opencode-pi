# Control center refactor: side-panel orchestrator layout (UI-first)

- **Date:** 2026-09-07
- **Decided by:** user (confirmed via clarifying questions + plan approval)
- **Topic:** gateway

## Decision

The single-file control center (`gateway/public/index.html`) is refactored from a
scroll-aside page into a side-panel UI with view switching: **Dashboard · Connections ·
Pipelines · Warehouse · Storage · Logs · Metrics** (+ Tools → Playground). Dashboard
gets a **Quick Sync** action that tests every known connection and pipeline against the
existing gateway endpoints from the browser. Pipeline cards carry runtime **metadata**
(status, events/sec, bytes, last-seen, endpoint, quant) plus an **editable note** per
card stored in localStorage. Model management moves to the Dashboard; the theme cycle
and live status bar are kept.

Scope is **UI-only with client-side checks** — no backend, no analytics service, no
warehouse/pipeline endpoints in this pass. Warehouse shows a designed-but-not-built
state; analytics/redis/sqlite/webhook/external-Qwen appear as "planned" connection
rows.

## Why

- The PRD §6.13 orchestrator UI is a documented requirement, and the user wants its
  navigation/structure now without waiting for the analytics backend — the existing
  endpoints cover gateway/llama/model/host/logs/requests, which is the data that
  exists today.
- Client-side checks keep the change reversible and low-risk (single static file) and
  match "quick sync … to test connections and pipelines" without building server-side
  state.
- Editable notes are persisted in localStorage because there is no server store yet;
  they are a placeholder for future per-pipeline metadata persistence on the backend.
- Frontend-first lets the backend (analytics serving layer, warehouse proxies) land
  later and slot into the already-defined panels (PRD §6.13, decision
  `2026-09-06--analytics-layer-docs-refresh.md`).

## Supersedes / relates to

- Implements the UI shape described in `2026-09-06--analytics-layer-docs-refresh.md`
  (decision §8, orchestrator UI) — this is the first code step for it.
- Relates to `2026-09-06--restart-button-visible-feedback.md` (control plane UI
  work) and `2026-09-05--control-center-v2-scope.md`.