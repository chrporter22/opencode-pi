# Analytics: TFLite live classify, runtime config/feature filter, cron, meta + dashboard

- **Date:** 2026-09-07 18:05
- **Developer:** opencode (big-pickle)
- **Topic:** analytics

## Request

Three-part directive: (1) the deferred TFLite **live classifier** wiring (classify each ingest
window with the active TF-lite model, merge `nnRisk`/`nnProb`/`nnLatencyMs` into `analytics.risk`
for SSE/WS render, per-model inference sampling); (2) **runtime config** work (durable, UI-editable
config doc overlaying env defaults — EWMA/context/PCA knobs, per-feature filter, cron-scheduled
training, watermark); (3) a **dashboard upgrade** on the analytics card: PCA z-score + threshold
readout so a 1.5σ outlier is visible, quick **sync buttons** (manual TF inference, meta refresh),
meta metrics (system + ML speed / inference time + exact input vector into the model), and a
config / feature-filter / TF-model input panel.

## What was done

- **`nn.py::TFLiteClassifier`** — lazy TF import, caches interpreter keyed on artifact mtime,
  softmax-normalized `{nnRisk, nnProb, nnLatencyMs}`, crash-safe on dim mismatch; active risk
  model only.
- **`service.py::Analyzer`** — now takes `RuntimeConfig`; applies the `featureFilter[10]` mask
  *before* EWMA/PCA; on filter/decay/context change resets reference+context; merges the NN
  result into the `analytics.risk` record honoring model `enabled` + `sampling.windowEvery`;
  honors `ingestEnabled`. Added `infer_now()` (manual infer on latest window, outputs
  `analytics.infer`) and `meta()` (`analytics.meta`: input vector, filter mask, thresholds,
  system snapshot, model size, latency with `nnRuns`). `apply_settings()` persists + live-applies.
- **`training.py`** — reads all hps from runtime (not just env); incremental fine-tune feeds
  `training_features(since=watermark)`, re-opens SavedModel (`trainable=True`); on no new rows
  emits `training.skipped`; advances watermark to `training_max_window_start()`; registers the
  risk model (`upsert_model`) on completion; `status()` exposes `trainedUpTo` + `cron`.
- **`main.py`** — `GET/PUT /v1/analytics/config`, `POST /v1/analytics/infer`,
  `GET /v1/analytics/meta`; cron daemon thread (30s check) started in lifespan; health unchanged.
- **`cron.py`** — **fixed a matcher bug**: a bare literal value (e.g. min `30`) was wrongly parsed
  as `30..59` (the `else: b = hi` default), so `Cron("30 4 * * *")` matched every minute 30–59.
  Now a literal parses to exactly `{value}`. Caught by the new test `test_cron_matcher_five_field`.
- **gateway** — `control.ts` got `GET /api/analytics/meta`, `POST .../infer`, `PUT .../config`
  (proxy now supports PUT + JSON body; renamed shadowed `const body` → `json`).
- **UI (`gateway/public/index.html`)** — PCA z-bars per component with watch/high threshold ticks
  and "how far past" text (so 1.5σ is visible); `Run TF inference` + `Refresh meta` buttons; meta
  rows for input→TF model, TF inference (label + probabilities + ms), system/ML speed (cpu/mem/
  temp/disk + PCA ms + nn×count), ingest chip, watermark; `<details>` config panel: feature-filter
  toggles (with live values), EWMA/context/PCA/watchσ/highσ, cron + next-run, training hps, save via
  PUT. WS handles `analytics.infer` + `analytics.meta`.

## Verification

- analytics pytest: **21 passed** (new `test_runtime.py`: cron matcher incl. the bug regression,
  feature-filter masking + reference reset, config PUT persistence, watermark/strictly-after
  semantics, ingest-enable, runtime tunable minRows).
- gateway `tsc --noEmit` clean; vitest 65/66 (the 1 failure is a pre-existing stale
  `installed:false` route assertion — the real model file is now installed in /opt/qwen-model,
  unrelated to this change).
- UI inline script passes `node --check`.
- Live E2E through gateway: `GET /api/analytics/meta` returns live input vector + 10 enabled
  features; `PUT /api/analytics/config` (watchZ 1.5/highZ 2.0/cron `*/10`) applied and `nextRun`
  returned a valid future timestamp; `POST /api/analytics/infer` returned 404 (no trained model);
  config restored to defaults.

## Open / next

- TFLite live classify is fully wired but can only produce `nnRisk` once a risk model is trained
  (`modelActive:false`, rows ≪ 4000). Cron scheduler starts training on match once eligible.
- Models CRUD endpoints + registry panel (per-model filter/sampling) are planned but not yet added.
- Retained deferred list (§11 in analytics-layer.md): drift PSI/KL/KS, embeddings/sqlite-vec,
  Redis-escrow handoff, JSONL/CSV export, laptop opencode.json context fix.
