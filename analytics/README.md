# analytics — live risk & ML serving layer

Internal Python (FastAPI) microservice for the opencode-pi control center.
It turns gateway telemetry into live risk scores: per-window **EWMA/PCA drift**
plus optional **TF-Lite NN classification** (`normal | watch | high` with softmax
probabilities), and it trains that NN from the warehoused window history.

- Port `8081`, bound **inside the compose network only** — the gateway proxies it.
- Design/data contracts: [`docs/analytics-layer.md`](../docs/analytics-layer.md).
- Requirements/spec: [`PRD.md`](../PRD.md) §6.13.

## Data flow

```
gateway telemetry (system.metrics + request lifecycle, every ~5s)
        │  POST /v1/analytics/ingest   (x-ingest-secret)
        ▼
analyzer.ingest() ──► feature window (ANALYTICS_FEATURE_WINDOW_SEC, masked by feature filter)
        │                 │
        │                 ▼
        │        EWMA + PCA on the window ⇒ Hotelling T² / p-value ⇒ level (watch ±Z · high ±Z)
        │        TFLite NN softmax ⇒ nnRisk + nnProb[3]   (when a trained model exists)
        │                 │
        ▼                 ▼
  SQLite (windows/requests)   Redis (warehouse mirror)
        └────────────────────► EventBus ─► SSE /v1/analytics/stream + gateway WS fan-out
                                        (analytics.risk, analytics.infer, analytics.meta, training.*)
```

Every scored window emits an `analytics.risk` event with the `PcaSummary` shape
plus `nnRisk` / `nnProb` / `nnLatencyMs` whenever a trained risk model is active.
A gateway `x-ingest-secret` push keeps the WS fan-out in sync; if the gateway is
unreachable the score is still persisted in SQLite + Redis.

## Modules (`analytics/app/`)

| Module | Responsibility |
|--------|----------------|
| `main.py` | FastAPI app, routes, auth (single shared `INGEST_SECRET`), SSE stream, cron thread kicker |
| `service.py` | `Analyzer`: ingest → feature window → EWMA/PCA scoring → `analytics.risk`; meta/pca/cloud/history endpoints; NN merge |
| `nn.py` | `TFLiteClassifier`: lazy TF import, caches the interpreter per artifact mtime, softmax inference |
| `training.py` | `TrainingOrchestrator`: first build / subsequent fine-tune, random-search trials, macro-F1 best-model selection, SavedModel + TFLite export |
| `features.py` | `FEATURE_NAMES` catalog and window normalization (the input vector) |
| `warehouse.py` | `SqliteStore` (windows, requests, reference, models, training runs) + `RedisStore` (status passthrough) |
| `events.py` | In-process `EventBus` for live fan-out (SSE + gateway push) |
| `runtime.py` | `RuntimeConfig`: runtime-tunable settings persisted to SQLite (feature filter, EWMA, thresholds, cron, watermark, training hyper-params) |
| `cron.py` | `Cron` schedule: `maybe_start` training on a cron pattern |
| `mathlib.py` | Pure helpers (EWMA/PCA/z/T²/p-value, label tiers, classification metrics) — unit-tested, no heavy deps |
| `backtest.py` | `Backtester`: hold-out backtest of a trained TFLite model into the separate `backtest_*` datasets |

## Config (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANALYTICS_PORT` | `8081` | HTTP port (compose: internal only) |
| `INGEST_SECRET` | — | shared secret for `/v1/analytics/*` (internal; the gateway adds it as `x-ingest-secret`) |
| `ANALYTICS_GATEWAY_URL` | `http://gateway-dev:8080` | gateway base for score push |
| `REDIS_URL` | — | optional Redis mirror (status read by the Warehouse view) |
| `ANALYTICS_DB_FILE` | `/data/analytics.db` | SQLite path (warehoused volume) |
| `ANALYTICS_FEATURE_WINDOW_SEC` | `60` | telemetry aggregation window |
| `ANALYTICS_CONTEXT_WINDOWS` | `12` | EWMA/+PCA context window count (fixed; not the LLM ctx) |
| `ANALYTICS_EWMA_DECAY` | `0.1` | EWMA decay factor |
| `ANALYTICS_PCA_COMPONENTS` | `6` | retained PCs |
| `ANALYTICS_PCA_WATCH_Z` / `…_HIGH_Z` | `1.0` / `1.5` | PCA z-score thresholds (cloud/bars display; define labels only when `labelMode=z_score`) |
| `ANALYTICS_LABEL_P_WATCH` / `…_LABEL_P_HIGH` | `0.10` / `0.05` | T² p-value label tiers: `p ≥ 0.10` normal · `0.05 ≤ p < 0.10` watch · `p < 0.05` high |

`labelMode` (`p_value` | `z_score`) is a runtime setting persisted in SQLite —
switch it via `POST /v1/analytics/relabel` (`mode` field, persisted to config,
applies immediately to the dataset and live ingest).
| `ANALYTICS_ML_DIR` | `/opt/qwen-ml` | model artifacts mount (external; survives container recreation) |
| `ANALYTICS_EMBED_MODEL` | `risk.net` | TFLite artifact basename |
| `ANALYTICS_TRAIN_*` | see `config.py` | min rows, epochs, batch, trials, validation split, seed |
| `ANALYTICS_EMBED_ENABLED` | `false` | reserved for embedding (sqlite-vec) work |

Runtime settings (feature filter, thresholds, EWMA, cron, hyper-params) are
editable via `PUT /v1/analytics/config` and persist in SQLite — see the **Config
& input filters** panel in the control-center ML Analytics view.

## Endpoints (auth: `x-ingest-secret` header)

Read-only queries are open on the internal network; mutations require the header.

- `GET /v1/analytics/health` · `GET /v1/analytics/config` · `PUT /v1/analytics/config`
- `GET /v1/analytics/meta` — model/artifact info, thresholds, input vector, latency
- `POST /v1/analytics/infer` · `POST /v1/analytics/infer/current` — NN scores (or 404 if no model)
- `POST /v1/analytics/ingest` — telemetry intake (the gateway webhook)
- `GET /v1/analytics/risk` (alias `/pca`) · `GET /v1/analytics/historic/windows`
- `GET /v1/analytics/pca/cloud` · `GET /v1/analytics/latency/history` · `GET /v1/analytics/reference`
- `POST /v1/analytics/rebaseline`
- `GET|PUT|DELETE /v1/analytics/models[/{id}]`
- `GET /v1/analytics/warehouse/sql` · `POST /v1/analytics/warehouse/query`
  · `GET /v1/analytics/warehouse/raw/{windows,requests}` · `GET /v1/analytics/warehouse/redis`
- `GET /v1/analytics/training/status` · `GET /v1/analytics/training/runs` · `POST /v1/analytics/training/start`
  (`mode`: `auto` | `watermark` | `full`)
- `POST /v1/analytics/relabel` — recompute drift labels across the whole dataset
  (idempotent upsert of `risk`/`t2`/`p_value`); returns the new class counts.
  Body: `{mode: "p_value"|"z_score", pWatch?, pHigh?, watchZ?, highZ?, retrain?}` —
  `p_value` (default) uses Hotelling T² p-value tiers, `z_score` uses PCA z-score
  thresholds; the mode is persisted to runtime config (`labelMode`)
- `POST /v1/analytics/watermark/clear` — clear the training watermark → next
  training is a full retrain
- `POST /v1/analytics/backtest` (`mode`: `current` | `train`) · `GET /v1/analytics/backtest/status`
  · `GET /v1/analytics/backtest/runs` · `GET /v1/analytics/backtest/samples`
- `GET /v1/analytics/stream` — SSE (`analytics.seed` then live `analytics.*` / `training.*` / `backtest.*` events)

## Live event contracts (SSE + gateway `/ws` fan-out)

`analytics.risk` (PcaSummary):

```jsonc
{
  "type": "analytics.risk",
  "projection": [...], "components": [...], "variance": [...], "eigenvalues": [...],
  "mean": [...], "std": [...],
  "drift": 1.24, "driftClassification": "normal", "risk": "normal", "confidence": 0.83,
  "heartbeat": 1758..., "lastRun": 1758..., "level": "normal",
  "t2": 1.24, "pValue": 0.17, "computeMs": 0.8, "windowsScored": 412, "modelActive": true,
  "level": "normal",                    // PCA/EWMA pipeline tier for the incoming window (label_from_p)
  "contextWindows": 12, "contextCap": 12,   // EWMA/PCA sample buffer count / cap (ANALYTICS_CONTEXT_WINDOWS)
  "pcScores": [{"i": 0, "z": 0.4, "value": 12.3}],
  "nnRisk": "normal",            // merged when a trained model is active
  "nnProb": [0.62, 0.21, 0.17],  // normal | watch | high
  "nnLatencyMs": 4.1
}
```

Class names are `LABEL_NAMES = ("normal", "watch", "high")` and always appear in
that order in `nnProb`. The control-center ML view renders these as the primary
NN scorecard; the PCA/EWMA rows (T², p-value, per-PC z-bars) stay secondary.

The scorecard distinguishes two labels: the **pipeline label** (`level`,
"T² p" chip — the incoming window's PCA/EWMA Hotelling T² p-value tier, computed
on ingest and persisted to SQLite as the stored label) and the **tf-lite class**
(`nnRisk`, the model outcome). The three probability bars fill each class's
**true % of the whole** exactly (`width = p·100%`, with a 6px hairline for ~0%
classes so no bar ever vanishes; no display floor is applied). The incoming
window's context buffer count (`contextWindows`/`contextCap`) is shown on the
scorecard, the Live card, the Metrics context spark, and the pipeline docs, so
the EWMA/PCA window metrics are first-class pipeline metrics (not just stored in
SQL).

`analytics.meta` carries `inputFeatures`, `inputFilter`, artifact sizes,
`thresholds`, `system`, latency/history counters, and `context` = `{count, cap}`
of the EWMA/PCA sample buffer. `training.*` events stream trial metrics
(`precision/recall/accuracy/F1`, confusion matrix) and run state.

## Training

- Cron-triggered (`cron` in runtime config) via `trainer.maybe_start(analyzer)` and
  also on every ingest once `train_min_rows` labeled windows exist.
- First run builds a fresh Keras model; later runs **fine-tune** it on the
  cumulative labeled history — storage is never wiped.
- Random-search hyperparameter trials are logged to `training_runs`; the best model
  by macro-F1 (fallback accuracy) is exported as SavedModel + TFLite into
  `/opt/qwen-ml`. `POST /v1/analytics/training/start` forces a run (`mode: auto`).
  `mode: full` rebuilds from scratch; `mode: watermark` fine-tunes only rows after
  the current watermark.
- A persisted `running` state that survives a process restart is reset at startup
  (`TrainingOrchestrator.clear_stuck()`), so restarts never wedge the train gating.
- TFLite is exported **atomically** (tmp + rename); artifacts shorter than 1 byte
  are treated as present-but-empty ("no model").

## Labels

Drift labels are assigned per window from the Hotelling **T² p-value** tier bound:
`p ≥ labelPWatch (0.10)` → `normal`, `labelPHigh (0.05) ≤ p < labelPWatch` → `watch`,
`p < labelPHigh` → `high`; `None` → `normal`. Tiers are runtime-tunable. PCA
z-scores / σ / loadings / eigen are still stored and rendered (cloud, box-plots)
but no longer define labels. `POST /v1/analytics/relabel` re-derives labels for the
full stored history (e.g. after a tier change or a dataset upgrade).

## Backtesting

`Backtester` (`analytics/app/backtest.py`) scores stored window feature vectors with
the trained TFLite model and writes predictions into a **separate SQLite dataset**
(`backtest_runs` + `backtest_samples`); live `windows.nn_risk`/`nn_prob` are never
touched. Per-sample fields: `windowStart`, `actual` (stored label), `nnRisk`,
`nnProb` (softmax, `normal|watch|high` order), `modelWatermark` (the watermark of
the model that produced the prediction), `match`.

- `mode=current` — backtest the current model over every stored window.
- `mode=train` — record `w0` = current watermark, run a **full retrain**, then
  backtest only windows strictly after `w0` (true hold-out on data the previous
  model had never seen).

Each run emits `backtest.started` → `backtest.progress` → `backtest.done` (or
`backtest.error`) and stores per-run macro metrics (accuracy/precision/recall/F1).

## Deployment

- `analytics/Dockerfile`: `python:3.11-slim` + `libgomp1` + `uv`; builds with
  `TF_USE_LEGACY_KERAS=1`. Compose service `analytics` (internal, `:8081`), plus
  `analytics-test` running `pytest -q` with an isolated DB.
- Model artifacts mount: `/opt/qwen-ml` (external volume). SQLite lives at
  `ANALYTICS_DB_FILE`; Redis is shared via `REDIS_URL`.
- Tests: `analytics/tests/` (mathlib, service/ingest, ML layer, runtime config,
  warehouse query, orchestration e2e). Run inside `analytics-test` service.

## UI surface

The **ML Analytics** view in the React SPA (`ui/`, built into `gateway/public/`)
is organized into labeled sections (Live NN scoring · drift/telemetry/box-plots ·
PCA explorer · Training & backtesting · models · pipeline docs · **filters &
runtime at the bottom**). It renders the NN scorecard (with an inline "Run TF
inference" button), backtest panel (Backtest model / Train & backtest / Relabel /
Clear watermark + per-sample agreement table), 3D PCA, drift/T² history, per-feature
box-plots, telemetry sparks, training panel, models table, and config/filter panel.
All ML actions surface API errors inline. See `ui/` and `docs/analytics-layer.md` §12.