# tflite-500 fix, p-value relabel, backtesting, watermark clear, ML page rebuild

## Session
2026-09-09 ~12:45→17:00 (interrupted by container build + doc finishes). Repository: opencode-pi. No commit yet (user says don't commit). Follow-up of the docs round (`docs-round/2026-09-08-2330`).

## Why we started
User reported: TF-Lite button / ML page buttons "don't work"; model 500s; asked for backtesting, watermark, PCA scroll ease, and an ML page reorganization with filters at the bottom. Everything traceable to a small set of root causes.

## Decisions (confirmed with user)
- **Labels fixed by Hotelling T² p-value tiers** (user chose this over class weighting / σ-z labels): `p >= 0.10 → normal`, `0.05 <= p < 0.10 → watch`, `p < 0.05 → high`; `None → normal`. Tiers are runtime-tunable (`labelPWatch`/`labelPHigh` = `0.10`/`0.05`; env `ANALYTICS_LABEL_P_WATCH`/`ANALYTICS_LABEL_P_HIGH`). PCA z-scores / σ / loadings / eigen stay stored for the cloud/bars display — the NEW labels come only from the p-value; `watchZ`/`highZ` config fields now display-only.
- **Backtest = separate SQLite dataset** (`backtest_runs` + `backtest_samples`), never mutates windows' `nn_risk`/`nn_prob`/`risk`.
- **"Train & backtest" = full retrain, then backtest windows strictly AFTER the pre-run watermark** (true hold-out on live data that arrived after the previous training cut). `mode=current` = score every stored vector.
- **Repair now**: after the fix, relabel the stored dataset, retrain full, verify infer.

## Root causes found (all confirmed by logs/curl)
1. `/opt/qwen-ml/risk.net.tflite` was **0 bytes** (stale Sep 8 degenerate run) → `tf.lite.Interpreter` mmap → `ValueError: Mmap of '19' at offset '0' failed with error '22'` (EINVAL) → every `POST /api/analytics/infer` and live-tick NN inference 500'd. Keras `risk.net.keras` (45 KB) was valid; interactive convert produced a valid 5808-byte TFL3.
2. **Stale Redis `train:state`** = `{"state":"running", run:294, startedAt:1788922140070}` from a run killed when the container restarted → `TrainingOrchestrator.start()` returned False → "Run training" button silently did nothing.
3. **Degenerate model**: trained on 5 rows → f1 0.333, always "high". Old label distribution 954 high / 184 watch / 151 normal / 6 NULL (1294 windows).
4. **UI swallowed errors**: `api()` throws on non-ok, but components did `catch {}` → buttons looked dead.

## Implemented
Backend (all verified by tests + live curl):
- `analytics/app/mathlib.py`: `label_from_p(p, p_watch=0.10, p_high=0.05)`.
- `analytics/app/runtime.py` + `config.py`: `labelPWatch`/`labelPHigh` default-doc keys, `effective()` keys, `label_p_watch`/`label_p_high` props + env defaults.
- `analytics/app/service.py` `ingest`: label = `label_from_p(p_value, ...)`; `_model_active()` requires size ≥ 1.
- `analytics/app/nn.py`: `TFLiteClassifier._build/classify` treat empty file as "no model" (reset → None) → clean 404 instead of 500.
- `analytics/app/training.py`: atomic export (`write_bytes` to `.tmp` then `replace`); empty-convert raises; `status()["modelActive"]` size check; **new `clear_stuck()`** resets a persisted `running` state on startup (unless started <30s ago) so container restarts never wedge the train gating (called in `main.create_app`).
- `analytics/app/warehouse.py`: schema + `backtest_runs`/`backtest_samples` (with indexes); `relabel_windows(p_watch,p_high)` recomputes T²/p and upserts `risk`/`t2`/`p_value` (z/loadings untouched, idempotent); backtest store methods; `backtest_runs/backtest_samples/backtest_window_count/backtest_windows` (pending+index queries). NOTE: `backtest_windows(since=...)` initially had the `AND` appended AFTER `ORDER BY` → SQL syntax error caught live (run 2 "error: near \"AND\""); fixed to append `AND` before `ORDER BY` + regression test.
- `analytics/app/backtest.py` (new): `Backtester` — `current` and `train` modes, per-run thread + lock, `backtest.started/progress/done/error` events, per-sample `modelWatermark` = runtime watermark, metrics via `mathlib.classification_metrics`.
- `analytics/app/main.py`: 5 new routes (`POST /v1/analytics/relabel`, `POST /v1/analytics/watermark/clear` (clears runtime watermark + `trainer.state["trainedUpTo"]`), `POST /v1/analytics/backtest` (`mode` current|train), `GET /v1/analytics/backtest/status`, `GET /v1/analytics/backtest/runs`+`samples`), Backtester wiring, `trainer.clear_stuck()` at startup.
- `gateway/src/routes/control.ts`: mirror proxy routes (`/analytics/relabel`, `/analytics/watermark/clear`, `/analytics/backtest`, `/analytics/backtest/status|runs|samples`). Gateway typecheck passes (in-container).

Config/docs tests:
- `analytics/tests/test_relabel_backtest.py` (new, 6 tests: label tiers, hotelling ordering, relabel roundtrip keeps z, empty-tflite no-model, backtest store roundtrip + `since` clause, watermark-clear → full-retrain gating). `tests/test_service.py.make_cfg` needed the 2 new Config fields. Full suite green: **52 passed, 2 skipped** (E2E TF loop, env-gated).

UI (`ui/`):
- `types.ts`: `BacktestRun`, `BacktestSample`.
- `store/analytics.ts`: `backtest`, `backtestSamples`, `backtestActive` state.
- `lib/load.ts`: `loadBacktest()` (runs + samples + status, degree-catch).
- `components/MLAnalytics.tsx`:
  - New `Section` headings → page reorg: **Live NN scoring / Drift-telemetry-box / PCA cloud / Training & backtesting / Registered models / Docs & pipeline / Filters & runtime (bottom)**.
  - `NNScorecard` top: **"Run TF inference"** button + inline error.
  - `TrainingCard`: inline error (no more swallowed catch).
  - New `BacktestCard`: Backtest (current), Train & backtest, Relabel (T² p), Clear watermark, Refresh; last-run summary (state/mode/coverage/model watermark/agreement/metrics), and a `table[data-ml-backtest]` samples table (when / actual / tf-lite / probs / match). Errors info inline.
  - PCA wheel: combined x/y delta, gentler 1.06 step, zoom range 0.15–12.
- `index.css`: `.ml-section` + `.ml-section-title`.

## Deployment + live repair (subtask: deploy)
- `docker compose build analytics` (no bind-mount for app code) + `up -d`.
- On startup `clear_stuck()` reset the stale Redis run → status `state=idle`, `error="stale run reset on startup"`, `tfliteBytes=0`, `modelActive=false`.
- `POST /api/analytics/infer` → clean 404 (was 500).
- `POST /api/analytics/relabel` → **1317 windows relabeled → normal 608 / watch 43 / high 666** (much healthier than the old 954-high skew).
- `POST /api/analytics/training/start {"mode":"full"}` → run 296/297 → **tflite exported 7312 bytes**, `modelActive=true`, trainedUpTo = latest window.
- `POST /api/analytics/infer` → **200** with real `nnRisk=normal`, `nnProb=[0.58,0.01,0.40]`, `nnLatencyMs=0.22`.
- `backtest current` (run 1): 1325 windows scored in <1s, **609/1325 match stored p-labels** → acc 0.462, macro-F1 0.211 (early-model truth: still weak, honest).
- `backtest train` (run 3): full retrain + hold-out the 2 live windows after the pre-run watermark → 0/2 (model weak on unseen). run 2 showed the `AND` SQL bug, fixed + rebuilt + re-ran.

## UI ship + verification
- Rebuilt in `ui-dev` (node:22) container path per AGENTS.md: `npm ci && npx tsc --noEmit && vite build && vitest` — green. dist hashes now `index-C-_Al5XE.js` / `index-sQ71_TSZ.css` (was `index-CJnQO9fv.js`/`index-DgczSoyJ.css`). Swapped into `gateway/public/` (rm assets, copy index + assets).
- **SPA sweep (`ui-sweep-spa.mjs`, pi-sweep image, SWEEP_URL=gateway-dev:8080, host ms-playwright mounted at /ms-playwright):** all 9 views render, `overflow []`, `wsOk=true`, `wireOk=true` (23 rows), **`errors []`**.
- Focused ML check (`ui-ml-backtest-check.mjs`): 7 sections, backtest/train/relabel/watermark/refresh buttons present, samples table populated (2 rows, run 3), zero console/page errors.

## Unfinished / follow-ups
- Model quality is still poor (acc 0.46 on p-labels, 0/2 hold-out). Next levers (NOT done, user hasn't asked): class-balanced sampling, feature selection, more data, threshold calibration, or p-tier tuning.
- Runtime config UI: consider exposing `labelPWatch`/`labelPHigh` in the Config card eventually.
- Production image `pi-gateway-prod` still stale (built 16h ago, predates today's UI + gateway changes) — rebuild when shipping.
- `best` field in training status is None after a full run while `modelMetadata` has the metrics (cosmetic; stored run row has them).
- SWEEP tip for later sessions: `pi-sweep` image has empty `/sweep` + no browsers; run with `-v /tmp/opencode:/sweep` and `-v /home/pi5_nvme/.cache/ms-playwright:/ms-playwright -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`.

## Round 2 (same session ~17:10+) — probability bars + context-window metric + pipeline label

User request (slightly cut off at the end): "update the percentage bars on the tf lite inference only watch shows for now on live risk update the others; also can you add context window counts so those metrics are part of the pipeline". Clarified with user: the bars must also display the **incoming window's PCA/EWMA pipeline label** (`risk.level`), which today lives only in SQLite; the bars themselves are the model's per-class distribution.

Approach (user-approved): display softening — `softProb(p, floor=0.10)` floors each live probability at 0.10 and renormalizes for **bar width only** (argmax/label/order unchanged); matcher already ran on the raw one-hot. This is display-only; the model's probabilities are untouched.

Findings: live `risk.nnProb` is near-exactly one-hot (`[1.0, 0.0, 0.0]` at context 8/12) → without softening only the winning bar makes noise on live updates. `setRisk` already overwrites `infer`, so live ticks re-render everything.

Implemented:
- `analytics/app/service.py`: `_pca_summary(..., contextWindows, contextCap)` → both keys in the risk payload; ingest passes `len(self.context)` + `runtime.context_windows`; `risk()`/`pca_summary()` fallbacks carry the same keys; `meta()` adds `context: {"count", "cap"}`.
- `ui/src/types.ts`: `AnalyticsRisk.contextWindows?/contextCap?`, `AnalyticsMeta.context?: {count?, cap?}`.
- `ui/src/lib/math.ts`: `softProb(p, floor=0.10)` → null unless length 3.
- `ui/src/store/analytics.ts`: state `ctxHist: number[]` (init `[]`), pushed from `risk.contextWindows` in `setRisk` (slice(-60)).
- `ui/src/components/MLAnalytics.tsx`: NNScorecard now shows **pipeline label "T² p" chip** (`risk.level`) + p-value + **tf-lite class** chip separately; three bars via `softProb` with `◂` marker on the tier row (row key = `\u25c2`); context windows N/cap row; LiveCard gains pipeline label + context rows; Metrics adds `ctx windows` spark (max = contextCap); PipeFlowDocs label step updated ("T² p tier ≥ 0.10/0.05") + live context note. `ui/src/components/NNCard.tsx` (Overview): pipeline chip + softened bars.
- Backend test `test_risk_carries_context_window_counts` added → suite **53 passed / 2 skipped**.

Verified live: analytics rebuilt/restarted (`docker compose build analytics && up -d`); buffer refills on the 60s ingest cadence (risk level flips from None → normal once 2 windows scored, later a live **watch** tier p=0.057 while the model said **normal** — the disagreement the user wanted visible). Focused sweep confirmed: three bars visible **85 / 8 / 8** with `watch ◂` marking the pipeline tier, pipeline chip `watch · p 0.0570`, tf-lite chip `normal · model active`, context `9/12`, **zero console/page errors**. SPA sweep re-run green (9 views, `errors []`, wsOk/wireOk true).
Dist hashes after this rebuild: `index-3EB-zo74.js` / `index-C-tjFutP.css`.

Docs/memory: analytics/README.md (risk event shape + scorecard pipeline-label/softening/context paragraph + `meta.context`), docs/analytics-layer.md §12 latest note + scorecard bullet + Metrics sparks list updated.

## Round 2b (same session ~17:40+) — bars: true %, remove softened floor

User feedback killed the softProb floor idea (tried 0.10 then 0.20): "watch just seems fixed … the fill bar isn't working" — with near-one-hot live output the additive floor pinned the losing classes to a constant ~14% while the labels moved. **Removed `softProb` entirely and deleted it from `ui/src/lib/math.ts`.** Bars + % labels now use the model's true `nnProb` directly: `width = max(p·100%, 6px)` (6px hairline so ~0% classes never vanish), label `pct()` = integer % above 0.1 else one-decimal (0.0% readable). Renamed the inline formatter to `pc()` (a module-level 3-arg `pct(z,v,scale)` already exists for the per-PC z bars and must not be shadowed). NNScorecard (MLAnalytics.tsx) + NNCard (Overview) both updated; captions now "bars fill the model's true % per class (zeros keep a hairline sliver)". Verified: live shows normal 100%/watch 0.0%/high ◂-marker independent (pipeline watch p=0.0796 vs model normal) — fill == % exactly; SPA sweep green again. Dist `index-wItBol-j.js` / `index-C-tjFutP.css`.

## Verification carried
- Backend pytest 52 passed / 2 skipped (53 after the round-2 context test); gateway + ui typechecks; ui vitest 8/8; production build of the UI through the real container path.
- Round 2 live checks: `/api/analytics/risk` carries `contextWindows/contextCap` + `meta.context {count,cap}`; UI focused sweep asserted pipeline chip, softened 3-bar widths, ◂ tier marker, context row; full SPA sweep green.