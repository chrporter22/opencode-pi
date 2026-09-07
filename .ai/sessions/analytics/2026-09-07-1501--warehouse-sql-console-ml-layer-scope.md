# Warehouse connections + SQL console; then ML layer / PCA explorer scope

- **Date:** 2026-09-07 15:01
- **Developer:** opencode (big-pickle)
- **Topic:** analytics

## Request

(1) Add warehouse connections to the UI, update pipelines, add a read-only SQL window to
test the sqlite tables and inspect raw historical data. (2) Follow-up directive: metrics
sparkline for NN inference ms (+ more ms placeholders), analytics snapshot on the dashboard,
full Analytics page under the Tools sidebar, a PCA 1v2 2D plot (cycle dims, tooltips,
sparklines, per-point values, crosshair, viridis, size ∝ component, outlier halos), a 3D
PCA cloud that rotates with selectable points, a feature highlighter incl. meta + training
data on the analytics layer, Machine Learning layer branding, a TF training pipeline for
softmax multiclass nominal logistic regression with hyperparameter tuning + random search,
and full model metadata.

## What was done

- **Backend (warehouse):** `warehouse.py::query(sql, limit=200)` — read-only guard
  (SELECT/WITH/EXPLAIN via `file:{path}?mode=ro` + PRAGMA whitelist
  table_info/index_info/index_list/foreign_key_list), BLOB cells decoded, row cap +
  `truncated`. `raw_windows(limit)` / `raw_requests(limit)` return latest raw rows with
  decoded feature arrays.
- **Backend (endpoints):** `POST /v1/analytics/warehouse/query` (400 on ValueError) and
  `GET /v1/analytics/warehouse/raw/windows|requests` (limit 1..200) in `main.py`.
- **Gateway:** `control.ts` proxies for warehouse query (POST body) + raw windows/requests
  (limit passthrough). `tsc` clean, `py_compile` clean.
- **UI:** connections — replaced the "Planned connections" card with live
  `conn-wh-sql` / `conn-wh-redis` cards, `whsql`/`whredis` checks + CONN_ID_MAP entries,
  data fill in `renderConnections()`. Pipelines — added `pipe-warehouse` card +
  `renderPipelines()` fill. Warehouse view — connection summary, read-only SQL console
  (sample queries, Run, results table), raw windows/requests tables with limit select,
  `loadWarehouse()` / `runSql()` / `loadRaw()` / `renderResultTable()`; wired to refresh()
  + showView("warehouse"). UI JS passes `node --check` (verified pre-ML-scope).
- **Tests:** `analytics/tests/test_warehouse_query.py` — SELECT reads rows, BLOB decode,
  write rejection (`DELETE`/`INSERT` refused, count unchanged), row truncation,
  raw windows/requests shapes. Tests written but **not yet run** (analytics container not
  rebuilt at time of writing).
- **Docs:** `docs/analytics-layer.md` §9/§9b/§11 updated earlier this session for the
  TFLite/runtime-config work; warehouse/query endpoints still to be documented.

## Notable findings

- Analytics image bakes code at build time (no bind mount) — must rebuild analytics to
  deploy `warehouse.py`/`main.py` changes; gateway-dev is bind-mounted.
- `training.py` already does random-search hps + softmax 3-class (normal/watch/high);
  plain "nominal logistic regression" (softmax with no hidden layer) is not yet in the
  search space. `models` table has no `metadata`/`deleted_at`; `windows` has no NN-latency
  columns. Both are scope for the ML-layer follow-up.
- The repo soft-delete rule (every collection carries `deletedAt`) was not applied to the
  analytics sqlite schema; models registry work should add `deletedAt` going forward.

## Open threads

- Warehouse UI/backend test + deployment verification pending (pytest in rebuilt container,
  live E2E through gateway, `node --check` re-run).
- ML-layer phased plan pending user answers: 3D plot approach (canvas vs WebGL lib), NN
  latency persistence (DB migration vs UI-only), plot sparkline semantics (per-point
  tooltip sparkline + time strip), delivery order.