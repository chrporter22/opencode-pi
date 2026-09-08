# Analytics rename = branding only; persistence moves to host bind; TF write-back & 3D PCA scope

- **Date:** 2026-09-07
- **Decided by:** user (openended review of the 15-item rumble; answers given at 20:50)
- **Topic:** analytics

## Decisions

1. **Rename is UI/branding only.** The product view is "ML Analytics" (sidebar `ml-analytics` page).
   API routes stay `/api/analytics/*`, env vars stay `ANALYTICS_*`, the compose service stays
   `analytics`. Never renames routes/services/env — those live forever.
2. **SQLite persists across `docker compose down -v`** via a host bind mount: store file at
   `/opt/qwen-ml/analytics.db` (covered by the existing `- /opt/qwen-ml:/opt/qwen-ml` volume).
   The old named volume `analytics-state:/data` was dropped because `down -v` deleted it.
   `redis-data` remains a named volume (AOF lost on `down -v` — accepted).
3. **TF write-back = predictions as telemetry only.** After training, the model retro-classifies
   stored windows and persists the results as telemetry/score data. It does **not** relabel stored
   windows, so there is no feedback loop into training labels.
4. **Training resumes where it left off.** Labeled windows past `watermark` trigger incremental
   fine-tuning (`layer.trainable=True`, dataset `since=watermark`), and the watermark advances on
   each completed run. A `should_train`+`maybe_start` gate prevents training thrash on every ingest.
5. **3D PCA explorer is a pure 2D-canvas projection** of the top-3 PC plane (with dim cycling and
   drag/zoom/hover/click). No WebGL, no new frontend dependencies — matches the single-file,
   zero-dependency UI.
6. **TF aarch64 stability pin.** TF 2.16.2 SIGABRTs inside the TFLite converter on arm64. Fix is a
   pin (`tf_keras<2.17` + `TF_USE_LEGACY_KERAS=1`), not a TF major upgrade — avoid framework churn
   until a proven good version exists on this hardware.
7. **UI ergonomics.** Analytics UI is a full page under Tools, not a dashboard card; all pages default
   to concise row-level **compact mode** with a topbar toggle; the statusbar is **per-page**; every
   connection card has a quick-sync button and the ML artifact store is its own connection. Warehouse
   raw views show labeled feature names + z-scores (the "raw values not showing" fix). Context windows
   are editable from the config panel.

## Why

- Sidebar/route naming: renaming API surfaces would ripple through the contract, gateway proxy and the
  frontend contract mirror for no functional gain.
- Host bind: the user explicitly wants analytics data to survive recreation (`down -v`); only the
  analytics DB is worth that guarantee today.
- Telemetry-only write-back: relabeling stored windows with model predictions would train the model on
  its own output (self-confirmation), corrupting the drift/risk signal.
- Canvas 3D: keeps the UI dependency-free and build-less like the rest of the app; interactivity needs
  are modest.
- Per-page statusbar + compact mode: dashboard real-estate/clarity; the full analytics surface belongs
  on its own page.

## Supersedes / relates to

- `.ai/decisions/gateway/2026-09-05--analytics-and-risk-layer-architecture.md`
- `.ai/decisions/gateway/2026-09-06--analytics-layer-docs-refresh.md`
- `.ai/sessions/analytics/2026-09-07-2045--ml-analytics-ui-overhaul.md` (this session's work log)