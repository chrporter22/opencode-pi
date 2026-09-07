# Session: analytics service — start build (milestone scoping)

Date: 2026-09-07 (slot 1214)

## Request
"ok start building analytics services"

## Context loaded
- Decision `2026-09-05--analytics-and-risk-layer-architecture.md`: analytics = separate
  Python FastAPI microservice (`analytics/`, :8081), Redis, EWMA+PCA reference, numeric-only.
- Decision `2026-09-06--analytics-layer-docs-refresh.md`: service evolved to a live ML
  serving layer (re-score each window), gateway-proxy-only access (`/api/analytics/*`),
  top-3-PC ±1.5σ label rule, PCA up to 6 comps, dual embedding stores, `/opt/qwen-ml`
  artifacts, `analytics-train` service, Redis warehoused.
- `.opencode/plans/analytics-and-risk-layer.md`: full v2 implementation plan with ordered
  subtasks and endpoint/WS/env/compose deltas. Docs refresh already DONE (2026-09-06).
- `docs/analytics-layer.md`: authoritative data contracts.

## Codebase ground truth (gathered)
- docker-compose.yml has only `gateway-dev` and `gateway-test`; no `analytics`/`redis`
  services yet. Only `8080:8080` published.
- gateway/src: config.ts (env-driven), routes/control.ts (admin `/api/*` CRUD+proxies),
  routes/v1.ts (inference plane), ws.ts (admin fan-out), requests.ts (RequestRecord ring),
  metrics.ts, logger.ts, state.ts, modules/llama/supervisor.ts.
- Python 3.13.7 + pip 25.3 available on host. No `analytics/` dir yet.
- `.env.example` is full-sample; `.env` current gateway+llama+model only (no ANALYTICS_*).
- Control router exposes GET/POST on `/api/*`; natural place for `/api/analytics/*` proxies.

## Decision/scope — PENDING user approval (this session did NOT write code)
The plan lists one big ordered milestone list. I gathered the plan and will present a
concrete staged scope + get approval before writing code (per repo rule: clarify then plan
approval before implementation).

## Open
- Await user direction on: first milestone slice (scaffold vs warehouse vs ingest vs full),
  whether to pull the full analytics stack now, and confirm top-of-repo multi-repo split
  is not needed (analytics lives in this repo per decision).