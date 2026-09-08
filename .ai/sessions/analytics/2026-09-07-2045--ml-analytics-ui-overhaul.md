# ML Analytics UI overhaul: 3D PCA explorer, per-page status bar, collapse-rows, persistence, TF write-back + incremental training

- **Date:** 2026-09-07 20:45
- **Developer:** opencode (big-pickle)
- **Topic:** analytics
- **Status:** **complete** (deployed + verified)

## Request (paraphrased from user's 15-item direct rumble at session 2045)

1. Analytics under **Tool** on the sidebar as `ml-analytics`; 3D PCA plot on that page
   (cycle components, move around cloud, crosshair pointer, select point → tooltip with
   row-level feature ingest details, PCA component score, z-score, sparkline, rich metadata).
2. Bottom **status bar changes per page**: connections, streams, metrics, logs.
3. All pages **collapse to concise row-level** with option to put cards back at top.
4. **Bug:** analytics TF model won't write back for reference/telemetry after training.
5. **Bug:** ingest window metrics raw values not showing.
6. Dashboard scorecard more concise; full analytics options on the ml-analytics page.
7. **Path (UI) to update context windows.**
8. Time series bar chart + PCA box plots by features on the analytics page.
9. Add **z-score to window dataset**.
10. SQLite **persistent even after `docker compose down -v`** (data comes back up).
11. TF-Lite training based on **row + watermark updated dynamically** so model resumes where
    it left off.
12. TF-Lite **fine-tuned after first training** so model always has new data.
13. ml-analytics **sparkline for training and telemetry**.
14. Update **connections, warehouse, pipelines, streams, storage** for ML artifacts and the
    paths for SQLite and ML artifacts.
15. (Added at 21:10) Warehouse page preset SQL with key column. → **leaned out**, not required.

## User-confirmed answers (20:50)

- **Rename scope:** UI/branding only. API routes `/api/analytics/*`, env vars, compose service
  name stay `analytics`.
- **Persistence path:** `/opt/qwen-ml/analytics.db` (host bind via `- /opt/qwen-ml:/opt/qwen-ml`).
  Only SQLite; redis-data stays a named volume.
- **TF write-back bug:** retro-classify stored windows and persist predictions as telemetry.
- **Raw-values bug:** feature names + z-scores visible in raw views.
- **3D PCA:** pure 2D canvas projection (repo-consistent, no new deps).
- **Compact mode:** default ON with a topbar toggle to restore full cards.

## What was built

### Phase 1 — analytics backend (verified in live containers, tests green)
- Warehouse: `pca_cloud` rows now include **`features[]` (raw feature values) + `z[]`** and the
  response carries **`featureNames`**; `raw_windows`/`raw_requests` return named features + z.
- `REQUEST_FEATURE_NAMES` option added so feature names stay stable across runs.
- Training gating fixed: `should_train()` returns False when a model is active AND no labeled
  windows exist past `runtime.watermark`; `maybe_start(analyzer)` wraps gate+start. Run advances
  only via `start()`; <5 labeled rows → `training.skipped`.
- TF 2.16.2 aarch64 fix: it SIGABRTs in the TFLite converter; pinned `tf_keras>=2.16,<2.17` +
  `ENV TF_USE_LEGACY_KERAS=1` in `analytics/Dockerfile` + `analytics/requirements.txt`.
- Welcome-endpoint + active checks; redshift+frontier always green; `training_runs`,
  `latency/history`, `pca_cloud` all populated.
- Tests: `test_service`, `test_ml_layer`, `test_ui_overhaul`, `test_ml_e2e` (E2E gated).

### Phase 2 — UI (gateway/public/index.html, single-file app)
- Sidebar **ML Analytics** entry under Tools (before Documents); topbar **Compact** toggle.
- Dashboard analytics card shrunk to a compact scorecard with `Open ML Analytics` link;
  ingest/training/best/config rows moved to the ML page Live card.
- New `#view-ml-analytics` page: scorecard (risk, T²·p, compute·nn ms, windows, input→TF rows),
  **3D PCA explorer** canvas (drag rotate / wheel zoom / hover inspect / click pin / Cycle dims /
  Rotate / Reset), drift·T² bar history, per-feature **z box-plots** with current marker,
  **telemetry sparklines** (T², compute, nn, F1, rows), training panel (state, rows/min, run,
  trials·epochs, artifacts, best model, trial log, Run training / Infer / Rebaseline / Refresh meta),
  models table, config panel with **`cfgCtx` context-windows input** prominent.
- Per-page **statusbar segments**: system / connections / pipelines / metrics / warehouse / ml;
  `renderStatusbar` safely merges `sysState`+`lastStatus` (empty-call safe).
- All pages support **compact row mode** (localStorage `piCompact`, default on).
- Connections: quick-sync button on every card + new **ML artifact store** card (`/opt/qwen-ml`).
- Warehouse raw view: labeled features + z column. Pipelines: TF training pipeline card +
  `wirePipeNotes` "ml". Storage: live `stMlDir`/`stWhPath`.
- Documents: analytics storage bullets live, `+18` analytics endpoint rows, `+13` ANALYTICS_* env rows.
- WS wiring: `analytics.risk` / `analytics.infer` → reload ML page; `training.*` → refresh training panel.

## Verification

- `node --check` on the extracted inline script: **OK**; no duplicate element ids; all
  `q("…")` targets resolve (only dynamic `btnThemeBar`/`sbClock` are built at runtime).
- Analytics suite (`docker compose run --rm analytics-test`): **46 passed, 2 skipped** (E2E gated).
- Gateway (temp copy `/tmp/opencode/gw`): `tsc --noEmit` clean, **66 tests passed (11 files)**.
- Gateway-dev bind-mounts `./gateway:/app` → new UI served live, no rebuild needed.
- Docs refreshed: `README.md`/`PRD.md` tables → `/opt/qwen-ml/analytics.db`; `docs/analytics-layer.md`
  §1/§6/§11/§12 updated (deployed status, real schema, UI surface).

## Notes / follow-ups

- Live DB is a **fresh empty** `/opt/qwen-ml/analytics.db`; old `analytics-state` volume
  (~12 min of data) exists if a copy is wanted.
- Pending user action (prior model-swap thread): `sudo ./scripts/install.sh --clean-old`,
  `docker compose up -d`, laptop model `qwen2.5-coder-3b-instruct-q4_k_m.gguf`.
- Optional future: preset SQL (key column) tool on the Warehouse page.