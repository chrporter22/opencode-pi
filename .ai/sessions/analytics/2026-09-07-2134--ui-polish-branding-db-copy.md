# UI polish round: branding, connections/pipelines/storage/logs/metrics layout, PCA plot styling, context-windows semantics + DB copy

- **Date:** 2026-09-07 21:34 → 21:58 (finalized)
- **Developer:** opencode (big-pickle)
- **Topic:** analytics (UI)
- **Decision ref:** `.ai/decisions/analytics/2026-09-07--ui-polish-round-and-swap-verification.md`

## Request (paraphrase)

Batch of UI polish + data tasks:
1. (Done by user) Qwen2.5-Coder-3B swap executed on the Pi — verify it.
2. Copy the old `analytics-state` volume DB over the fresh `/opt/qwen-ml/analytics.db`.
3. Answer: does the image need rebuilding for the swap?
4. Branding: page/model title shows the Qwen model name; subtitle on the index page.
5. Connections: fit all scorecards to the page.
6. Compact mode tighter / more row-level.
7. Pipelines: training (TF) scorecard spans the whole page; same for warehouse first scorecard on connections.
8. Storage: raw count + more metadata + persistent items.
9. ML logs + filter options on the Logs page.
10. ML sparklines on the Metrics page.
11. Drift + feature (box-plot) scorecards fit the whole screen, split 50/50.
12. PCA plot: light gridlines + viridis color by value + scale/key.
13. Training + inference card spans the whole page.
14. **context windows is for the Qwen model, not ML inference** — remove the cfgCtx ML config control; surface Qwen ctx instead.

## Done

- Model swap verified live via `/api/model` (x-api-key dev-admin-key): Qwen2.5-Coder-3B-Instruct, Q4_K_M, 2,104,932,800 B, sha256 724fb256…, contextSize 32768, llamaArgs `--ctx-size 32768`, loaded. **No image rebuild needed** (bind mounts for `/app`, `/models/host`).
- DB copied: `opencode-pi_analytics-state` volume `/data/analytics.db` (had 25 windows? initially 19 at copy time — live ingest keeps growing) → `/opt/qwen-ml/analytics.db` via root alpine helper. `warehouse._migrate()` added the `z` column on open (missing on old schema).
- **z backfill:** containerized python (analytics image, `/opt/qwen-ml` mounted) = `backfill_z.py` in `/tmp/opencode`. For each window uses the latest `reference` row with `updated_at < created_at` (pre-window EWMA state), recomputes `z=(x−μ)/σ` with `EwmaReference` formula (var=max(s2−μ²,1e-8), σ=sqrt(var), n<2→σ=1). Backfilled **25 rows** (blobs big-endian f32). Verified live: `pca/cloud` returns `z` arrays, risk/t2 present.
- **Stale artifact:** `/opt/qwen-ml/risk.net.keras` (pre-tf_keras-fix) could not be deserialized → training state was `error`. Deleted via root helper **and** cleared redis `train:state`; restarted analytics. `/api/analytics/training/status` now `idle`, error null, modelActive false.
- **UI (all in `gateway/public/index.html`):**
  - Branding: `<title>` = `Qwen2.5-Coder-3B-Instruct · opencode-pi Control Center`; topbar subtitle shows `name · quant · ctx N` via `#bModel` (set in `refresh()` from `/api/model`); Model card gains `#mCtx` context-window row.
  - Connections: moved Host card to the end; `conn-wh-sql` now `full`; grid rows now fill 3×3+full+full (gw/llama/model · sys/logs/reqs · oc/redis/mlm · host · warehouse sqlite).
  - Compact mode: added ~20 tighter row-level rules (card padding, h2, rows, tables, sparks, usage bars, log area, pipelines, buttons).
  - Pipelines: `pipe-ml` → `full` (warehouse already full).
  - Storage: new `#st-raw` (tables:rows, windows raw/labeled, requests, db size, latest window + risk, training artifacts, redis copy) and `#st-persist` (✓ host-bind items vs ✗ redis named volume wiped on down -v); feeds from `whSql`, `anTrain`, `whRedis`, `modelMeta` in `renderStorage`.
  - Logs: `LOG_SOURCE` filter (All/ML/Requests/System) with `logBuffer` re-render so level+source filters apply to history; `logTagInfo` returns `src`; `analytics.*`/`training.*` → `ml` tag (viridis-2 colored); row-level compact styles.
  - Metrics: second spark-grid with labeled rows / windows / requests / tflite sparks + `ML_HIST` (pushed from `loadAnalytics` + `loadWarehouse` every 5s refresh; renamed canvases `mSp*` to avoid id collision with ML-page `sp*`).
  - ML layout: drift T² + feature box wrapped in `.ml-split` (`grid-column:1/-1`; 1fr/1fr; stacks <860px); `ml-train` → `full`.
  - PCA: light gridlines (8×8), dots colored by `viridis(max|z| / highZ)`, high/watch keep amber/red, red halo on `z≥high` remains, tooltip gains `zmax`, gradient `.pca-scale` + swatch legend (low|z|→high|z|, watch, high risk, pinned).
  - Context windows: removed `cfgCtx` input + dirty watch + `patch.contextWindows` in `buildCfgPatch` + `ctx` in scorecard cfg line; replaced with read-only `#cfgCtxInfo` = Qwen ctx from `/api/model` (`contextSize` → "32768 tokens · llama.cpp --ctx-size").
- Verification: inline script `node --check` OK; **no duplicate ids**; all `q()` refs resolve (only dynamic `btnThemeBar`/`sbClock` unresolved, created at runtime, pre-existing); pytest **46 passed / 2 skipped**; gateway `tsc --noEmit` clean + **66 tests / 11 files** passed (run from `/tmp/opencode/gw` copy). Live API re-verified after restart.

## Blocked / Notes

- Config `contextWindows` env (ANALYTICS_CONTEXT_WINDOWS) remains a backend ingest setting; only its UI control was removed, per "ctx belongs to Qwen" decision.