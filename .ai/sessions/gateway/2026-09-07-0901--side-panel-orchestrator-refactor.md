# Side-panel orchestrator refactor (UI) — Dashboard/Connections/Pipelines/Warehouse/Storage/Logs/Metrics

- **Date:** 2026-09-07 09:01
- **Developer:** opencode (big-pickle)
- **Topic:** gateway
- **Preceding:** 2026-09-06 (restart button visible feedback; install/update 4-bit model scripts)

## Request

"refactor the ui so its side panel is dashboard; connections; pipelines; warehouse;
storage; logs; metrics; quick sync on the dashboard to test connections and pipelines;
pipelines for endpoints add metadata to the cards"

Clarified with user (all confirmed):
- **Scope: UI-only, client-side checks.** No backend/analytics changes this pass;
  Quick Sync and connection checks run in the browser against existing endpoints;
  Warehouse shows a designed-but-not-built state.
- **Model on Dashboard; keep Playground** as a sidebar item.
- **Pipeline cards: runtime metadata + editable notes** stored in localStorage.
- **Pending work (uncommitted from the two prior sessions): do not commit; write the
  `.ai` folder instead.**

## Plan (approved 2026-09-07)

1. View shell: sidebar converts from scrollspy-over-one-page to view switching,
   8 panels; keep topbar + statusbar + theme cycle.
2. Dashboard: status chips; model card (moved, restart/update/progress); Quick Sync
   runs per-connection/per-pipeline checks against existing endpoints with latency +
   aggregate + last-sync time.
3. Connections: cards for gateway/llama-server/model store/host/logs/requests
   (status, endpoint, latency, mini metrics) + host table + "planned" chips for
   analytics/redis/sqlite/webhook/external Qwen.
4. Pipelines: cards for llama inference, model update, client request streams with
   runtime metadata (kind/status/endpoint/events-sec/bytes/last-seen/quant) + an
   editable note each (localStorage), plus the existing request streams table.
5. Warehouse: planned-state card (SQLite + Redis views), no fake data.
6. Storage: disk usage bar + model file details + known paths.
7. Logs: event feed + level filter + history via /api/logs.
8. Metrics: live sparklines from renderSystem data (poll + WS).
9. Verify: node --check on extracted script, HTML balance, container typecheck.
10. Memory: this session file + decision file.

## Implementation notes

Rewrote `gateway/public/index.html` (frontend-only, no backend changes):

- **View shell.** Sidebar = Dashboard / Connections / Pipelines / Warehouse / Storage /
  Logs / Metrics (+ Tools → Playground); `data-view` links + `showView(name)` toggle
  `.view.hide`, replacing the old scrollspy. Topbar now holds the two key inputs +
  theme button; statusbar unchanged. New CSS: `.view`, `.span2`/`.full` grid spans,
  `.sync-item`, `.filter-bar`, `.usage-bar`, `.spark-grid`/`.spark-item`, `.pnote`,
  `.planned`, `.nav-sep`, `--ac-wh`.
- **Dashboard.** Model card (restart/update + progress + action line) + System summary
  moved here; **Quick Sync**: `CHECKS[]` = 6 connections (gateway /health, host
  metrics, llama-server, model store, logs, requests) + 3 pipelines (llama inference,
  model update, request streams); `syncAll()` runs sequentially with per-check latency,
  ok/failed/skipped(no-key) rows in `#syncList`, aggregate + last-sync-time; results
  cached in `syncResults` and reused by Connections + Pipelines.
- **Connections.** Cards per connection (status chip from live state + latency/last
  sync from syncResults), host table (moved), and a "Planned connections" card
  (analytics/redis/sqlite/webhook/external Qwen — backend pending).
- **Pipelines.** 3 cards — llama inference (endpoint parsed from `llamaArgs`,
  events/sec = rpm/60, bytes ≈ tokens from request records, tok/s, last-seen),
  model update (quant/size/file/installed), client request streams (status + the
  streams table moved here) — each with an editable note (`pnote-*`, localStorage
  `pipenote-*`).
- **Warehouse.** Designed-but-not-built card (SQLite + Redis views per PRD §6.13), no
  data.
- **Storage.** Disk usage bar (from `/api/system.disk`), model file details, known
  storage paths.
- **Logs.** Feed moved here + level filter (all/errors/warn+) + history load from
  `/api/logs` (guarded by `historyLoaded`).
- **Metrics.** Sparklines (canvas) for CPU/mem/temp/API-min/tok-s from
  `METRIC_HIST`, fed by `renderSystem` (both `/api/system` poll and WS
  `system.metrics`); redraw on theme change + panel open.
- Kept: request tracking table/click-to-log (`jumpToLog` now switches to Logs view),
  playground chat, WS connect, restart/update flows.

## Verification

- HTMLParser: no tag errors/unclosed. Extracted `<script>`: `node --check` clean.
- Cross-check: every id referenced in JS exists in markup; nav views ↔ view sections
  match; no duplicate ids.
- DOM-shim smoke test (node): top-level init OK; `renderSystem`,
  `renderConnections`, `renderPipelines`, `renderStorage`, `renderMetrics`,
  `showView`, `chip`, `syncAll` all ran without errors (authed checks correctly
  marked "admin key required"; failed `gw` fetch handled). No backend touched.
- `docker compose run --rm gateway-test npm run typecheck` → clean.
- NOT done: live browser check against a running gateway (dev container must be
  recreated).

## Open threads

- Static UI change needs `docker compose up -d --build gateway-dev` to be visible
  live.
- Where pipelines/warehouse analytics UX goes once the analytics service exists
  (PRD §6.13).