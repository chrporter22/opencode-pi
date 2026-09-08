# Analytics & Risk Layer — design

Status: **mostly deployed** (analytics service live behind gateway on the Pi; UI on the ML Analytics page).
This document is the data contract for the analytics microservice. Implementation is tracked separately.

## 1. Overview

A separate Python microservice (`analytics`, port `8081`) consumes numeric-only gateway
telemetry through a webhook and provides:

- **Confident baseline modeling** via an adaptive EWMA reference (per-feature mean/σ, PCA loadings).
- **Risk scoring** per window: Hotelling `T²` → exact `F/χ²` tail; the "≥1.5σ from the mean"
  rule gives normal / watch / high.
- **Drift detection** over historic stored windows (feature PSI, KS/MMD on PC scores, loading shift).
- **TF-Lite neural net** inference (context window → risk/drift probabilities), offline-trained.
- **Storage**: SQLite (+ `sqlite-vec`) for request/window embeddings; Redis for keys,
  rate limits, ingest escrow, and live-score cache.

Everything is numeric-only. No prompt, response, or reasoning content is ever transmitted,
stored, or logged (§6.7 #33 preserved).

## 2. Topology & transport

```
Control Center (browser) ──WS /ws (admin)──▶ gateway :8080 (TS)
                                                │
        ingest (batched, bounded Redis escrow)  ▼
                             POST /v1/analytics/ingest  (INGEST_SECRET)
                                                │
                      ┌─────────────────────────▼─────────────────────────┐
                      │  analytics :8081 (Python FastAPI)                 │
                      │   ├ feature + context-window builder              │
                      │   ├ EWMA reference + PCA eigen-decomposition      │
                      │   ├ risk scorer (T² → F/χ² tail) + drift checks   │
                      │   ├ TFLite NN (context window → probabilities)    │
                      │   ├ SQLite + sqlite-vec store                     │
                      │   └ Redis client (keys, limits, escrow, scores)   │
                      └─────────────────────────┬─────────────────────────┘
                                               │  POST /v1/analytics/scores
                                               ▼
                                      gateway → /ws broadcast
                                      (analytics.risk / analytics.drift)
```

- **Auth:** gateway→analytics calls carry `INGEST_SECRET` (or explicit token table in Redis).
  Analytics→gateway live-score push is authenticated by a gateway-side shared secret
  (`INGEST_SECRET` mirrored).
- **Decoupling:** the gateway never awaits analytics success for inference. Failures queue
  in Redis (`pending:analytics:ingest`) with a bounded size; flush on reconnect. Redis loss
  degrades to dropping queued batches with a warning (telemetry loss is acceptable; inference
  loss is not).

## 3. Features

Window aggregation interval: `ANALYTICS_FEATURE_WINDOW_SEC` (default 60).
Context window length: `ANALYTICS_CONTEXT_WINDOWS` (default 12).

| Group | Feature | Source |
|-------|---------|--------|
| Per-request | `log(promptTokens)`, `log(completionTokens)`, `log(totalTokens)` | `request.*` events / `GET /api/requests` |
| Per-request | `tokensPerSecond` | llama `print_timing` / response `usage` |
| Per-request | `log(durationMs)` | request lifecycle |
| Per-request | `error` (0/1) | request status |
| Window | `requestsPerMinute` | gateway tracker |
| Window | `errorRate` | request records in window |
| Window | `p95`, `p99` latency and `tok/s` | request records in window |
| System | `cpu`, `memory`, `temperature`, `diskUsedPercent`, `thermalRamp` at inference time | `system.metrics` / `/api/system` matched to window |
| Planned | `timeToFirstToken` | startedAt → first chunk (timing only) |
| Planned | Qwen3 thinking-share | numeric only — needs explicit approval; content never stored |

Context tensor per feature: last-N normalized window values, flattened
(`features` — 1D) plus `context` (last-N × P matrix). The TFLite model consumes the
single-window feature vector; the PCA risk scorer consumes the EWMA z-scores of the latest window.

### What "requests" means

The gateway's analytics pusher (`gateway/src/modules/analytics/pusher.ts`) snapshots every
**completed or errored** `/v1/chat/completions` call that started inside the window and sends
one `requests[]` row per call. Each row lands in the SQLite `requests` table with a 6-feature
vector (all `log1p`-transformed except the last):

| # | Feature | Meaning |
|---|---------|---------|
| 1 | `log1p(promptTokens)` | input tokens (from `usage`, or llama `print_timing`) |
| 2 | `log1p(completionTokens)` | output tokens |
| 3 | `log1p(totalTokens)` | prompt + completion |
| 4 | `log1p(tokensPerSecond)` | throughput |
| 5 | `log1p(durationMs)` | end-to-end request latency |
| 6 | `error` (0/1) | request status flag |

These are the fine-grained per-request source of the window's `requestsPerMinute`,
`errorRate`, and p95/p99 latency + tok/s aggregates. Backed up in memory bounds by the
gateway's bounded request ring (`GET /api/requests`, `request.*` WS events); numeric only —
never prompt/response content.

## 4. Data / normalization / reference

1. Windows are standardized against the EWMA reference: `z = (x − μ_ref) / σ_ref`.
2. The reference updates per window with decay `ANALYTICS_EWMA_DECAY`:
   `μ ← (1−α)·μ + α·x`, `S ← (1−α)·S + α·x²` (σ from S−μ²), loadings via recomputed
   covariance eigen-decomposition at a lower decayed cadence.
3. PCA: `k` components retained ≈ 95% variance (min `max(1, floor(k_max*0.95_variance))`),
   computed on the decayed covariance (power iteration / QR; tiny P×P).

`POST /v1/analytics/rebaseline` recomputes the reference from stored windows (or reset).

## 5. Risk model

Per window the scorer (`analytics/app/service.py::AnalyzerService.ingest`):

1. **Mask** the telemetry vector with the runtime `featureFilter` → `xf`.
2. **Whiten** against the EWMA reference: `z = (x − μ_ref) / σ_ref` (σ = 1 until ≥2 windows).
3. **Project** the last `context_windows` z-vectors onto the PCA loadings → per-window scores.
4. **Standardize** the latest window's score per component: `pcz = score_k / √(λ_k)` — the
   number of component-σ the current window sits on each retained principal direction.

**Risk label (`mathlib.risk_label`) — from the top-3 PC z-scores, NOT the p-value:**

- `normal` — every top-3 component has `|pcz| < watchZ (1.0)`
- `watch` — any top-3 component `watchZ ≤ |pcz| < highZ (1.5)`
- `high`  — any top-3 component `|pcz| ≥ highZ (1.5)` (both tails)

**Hotelling T² and the p-value are computed in parallel and are informational only**
(`mathlib.hotelling`): `T² = Σ_k pcz²` over retained components, `p = χ²(dof).sf(T²)` via the
pure-python continued-fraction tail; the UI shows `t2 · p` and `confidence = 1 − p` (clamped).
They do **not** influence the label — README §Analytics documents the same top-3-PC rule.

A trained **TFLite risk model** (`nn.py::TFLiteClassifier`) additionally classifies the same
window: it takes the *raw masked* feature vector `xf` and returns `{nnRisk, nnProb, nnLatencyMs}`
(a learned, single-forward-pass approximation of the PCA-labeler with non-linear decision
boundaries). `nnProb` is the softmax distribution over `normal | watch | high`; the UI shows
`nnRisk` on the scorecard chip and nn ms in the telemetry sparks.

Live outputs: `{ t2, pValue, level, components: [{i, loading, value, z}] }`.

**What this provides.** "Risk" reads as *drift from the recent adaptive norm*: the EWMA
reference forgets (decay α) so the baseline "normal" moves with the system; a `high` label means
a window that most of the last-N windows and at least one principal direction does not look
like. The PCA step compresses the 10 correlated telemetry features to the few independent
directions that matter, T² adds a single scalar distance, and the NN gives a fast,
trainable model of the same judgement that can run even without per-window PCA.

## 6. Storage

- **SQLite** `analytics.db` (host bind `/opt/qwen-ml/analytics.db`, survives `down -v`; WAL):
  - `windows` (per-window row: structured `feature_vec`, `context`, `pcs`, risk fields) —
    served via `pca_cloud` rows `{windowStart, features[], z[], pcs[], risk, t2, pValue, computeMs, nnMs, nnRisk}`
    with **named `featureNames`** and per-feature z-scores on `raw_windows`.
  - `requests` / `reference` (EWMA mu/sigma/loadings/eigen snapshot) / `training_runs` / `config` (durable runtime cfg) / `models` (registry).
- Persistence is a host bind mount at `/opt/qwen-ml` (also hosts ML artifacts); the old named
  volume `analytics-state:/data` was dropped because `docker compose down -v` deleted it.
- **Redis keys:**
  - `key:{hash}` → validated key record + TTL (key cache)
  - `rl:{hash}:{window}` → per-key request counter (rate limiting)
  - `pending:analytics:ingest` → bounded escrow list
  - `score:latest` → latest risk/drift JSON (shared gateway↔analytics)

## 7. API

### 7.0 Model serving — HTTP methods

The gateway (`:8080`) serves the model to clients (opencode, curl, Playground) and exposes
model lifecycle ops to the admin UI. OpenCode's `@ai-sdk/openai-compatible` provider targets
the OpenAI-compatible surface:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET  | `/v1/models` | inference key | model id (`Qwen2.5-Coder-3B-Instruct`), quantization, context window |
| POST | `/v1/chat/completions` | inference key (`Authorization: Bearer` or `x-api-key`) | streaming chat completions (SSE) through llama.cpp |
| GET  | `/health` | none | liveness |
| GET  | `/api/status` | admin key | gateway / llama / model state chips |
| GET  | `/api/model` | admin key | model meta: `name`, `quantization`, `sizeBytes`, `file`, `sha256`, `installedAt`, `contextSize`, `llamaArgs`, `loadingStatus` |
| POST | `/api/model/update` | admin key | download → verify → swap model job |
| POST | `/api/model/restart` | admin key | stop/start llama with current args |
| GET  | `/api/system` · `/api/system/host` | admin key | live cpu/mem/temp/disk/tok-s/throttle + host info |
| GET  | `/api/metrics` | admin key | rolling request metrics (api/min, p95/p99) |
| GET  | `/api/logs` | admin key | recent gateway log lines |
| GET  | `/api/requests` | admin key | bounded request ring (numeric telemetry only) |
| POST | `/api/analytics/infer` | admin key | manual TFLite risk inference on latest window |

The model id is *aliased* by the gateway to `Qwen2.5-Coder-3B-Instruct` whatever `.gguf` file
is swapped in, so clients can keep that id across model swaps.

### 7.1 Analytics service (`:8081`) — shared secret except where noted

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/v1/analytics/ingest` | Batched feature ingestion from gateway (pusher) |
| POST   | `/v1/analytics/rebaseline` | Manual re-fit / reset of EWMA+PCA reference |
| GET    | `/v1/analytics/health` | Liveness (no auth) |
| GET    | `/v1/analytics/risk` | Latest `PcaSummary` |
| GET    | `/v1/analytics/pca` | Latest `PcaSummary` (alias) |
| GET    | `/v1/analytics/historic/windows?limit=` | `HistoryPoint[]` (window history) |
| GET    | `/v1/analytics/reference` | EWMA mean/σ/n snapshot |
| GET    | `/v1/analytics/config` | Feature/training config |
| GET    | `/v1/analytics/warehouse/sql` | SQLite store status |
| GET    | `/v1/analytics/warehouse/redis` | Redis store status |
| GET    | `/v1/analytics/training/status` | Orchestrator state + best metrics |
| POST   | `/v1/analytics/training/start` | Kick a random-search training run |
| GET    | `/v1/analytics/stream` | **SSE** — `analytics.seed` then live `analytics.*` / `training.*` events |

### 7.2 Gateway proxy (`/api/*`, admin key) — proxied to analytics

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/analytics/risk` | Latest `PcaSummary` |
| GET    | `/api/analytics/pca` | Latest `PcaSummary` (alias) |
| GET    | `/api/analytics/historic/windows?limit=` | `HistoryPoint[]` |
| GET    | `/api/analytics/reference` | EWMA snapshot |
| GET    | `/api/analytics/config` | Config mirror |
| GET    | `/api/analytics/warehouse/sql` / `/warehouse/redis` | Store status |
| GET    | `/api/analytics/training/status` | Training state |
| POST   | `/api/analytics/training/start` | Start training run |
| POST   | `/api/analytics/rebaseline` | Re-fit reference |
| GET    | `/api/analytics/stream` | SSE pipeline: gateway → analytics `/v1/analytics/stream` (accepts `?key=` for EventSource) |

### 7.3 WebSocket fan-out

The gateway broadcasts over the existing admin `/ws` anything pushed from analytics
(`POST /api/analytics/scores`, shared secret) with a `type` of `analytics.*`, `training.*`,
`pca`, or `store.*` — currently `analytics.risk` (`PcaSummary`-shaped), `analytics.ping`,
`training.started`, `training.progress`, `training.done`, `training.error`,
`analytics.rebaseline`.

### 7.4 PcaSummary / HistoryPoint contract

```ts
export interface PcaSummary {
  projection: number[][];     // context PC score matrix (windows × k)
  components: number[][];     // PCA loadings (P × k)
  variance: number[];         // explained variance ratio per component
  eigenvalues: number[];      // eigen per component
  totalVariance: number;      // Σ eigen
  mean: number[];             // EWMA feature mean
  std: number[];              // EWMA feature σ
  drift: number;              // Hotelling T² of the latest window
  driftClassification?: string; // "normal" | "watch" | "high"
  risk: string;               // same label as driftClassification
  confidence: number;         // 1 − χ²-tail p (clamped to 0..1)
  heartbeat?: number;         // emit ts (ms)
  lastRun?: number;           // windowStart (ms)
}

export interface HistoryPoint {
  timestamp?: number;         // windowStart (ms)
  projection: number[][];     // single-row PC z-scores of that window
  drift?: number;             // T²
  risk?: string;              // "normal" | "watch" | "high"
}
```

## 8. Training data & dataset modeling

- Each window row in `windows` is **auto-labeled** by the live PCA risk labeler at ingest time
  (`risk`: `normal | watch | high`, stored alongside `z`, `pcs`, `t2`, `p_value`). Labels are
  *statistical drift labels*, never human labels.
- `training_features()` builds the supervised dataset: `X = feature_vec` (the **raw masked**
  telemetry vector normalized at runtime by the EWMA σ), `y = {normal:0, watch:1, high:2}`.
  The model therefore learns `raw-telemetry-vector → drift-risk-class` — a fast learned
  substitute for the per-window PCA/T² computation, with non-linear decision boundaries.
- **Incremental learning + watermark:** once a model exists each run queries only rows with
  `window_start > trainedUpTo` (watermark), then replays history for the first build.
  Fewer than 5 new labeled rows → `training.skipped` (state returns to `idle`, no error).
- **Hyperparameter search:** `ANALYTICS_TRAIN_TRIALS` random-search trials sample
  `kind ∈ {mlr (softmax logistic regression), mlp (relu Dense + Dropout)}`, plus
  `lr/batch/epochs/reg (L2)/units/layers/dropout`. A shuffled train/validation split is held
  out per `ANALYTICS_TRAIN_VALIDATION`. Per-trial precision/recall/accuracy/F1 + 3×3 confusion
  matrix via pure-python `mathlib.classification_metrics` (no sklearn). Best model = best
  macro-F1 (fallback accuracy).
- During training every trial streams as `training.progress` (`hp`, `metrics`, `confusion`,
  `bestSoFar`); the final choice is announced as `training.done` with
  `{best, modelFile, tfliteBytes}`. Failures stream `training.error` and persist a
  `training_runs` row with `state="error"` + the message.

## 9. Model artifacts

- Artifacts live in `/opt/qwen-ml` (host bind): SavedModel dir `risk.net.keras`-style and the
  quantized **TFLite** `risk.tflite` (default | INT8/weight quantization via
  `TFLiteConverter.optimizations`). The stale pre-fix `risk.net.keras` that failed TF
  deserialization was removed; a fresh one is written on the next successful run.
- **Lifecycle:** first build when labeled rows ≥ `ANALYTICS_TRAIN_MIN_ROWS` (auto) or on manual
  `POST …/training/start`; then load + `layer.trainable=True` fine-tune on new rows
  (storage never wiped). `train:state` (redis) survives restarts; deleting it + the old Keras
  artifact recovers from a broken state.
- **Live classification** (`nn.py::TFLiteClassifier`): lazy TF import, interpreter cached on
  artifact mtime; every scored window (with a PCA label) classifies its masked vector
  `→ {nnRisk, nnProb, nnLatencyMs}`, merged into the `analytics.risk` event. Manual run via
  `POST /v1/analytics/infer`.
- **Model registry:** each run `upsert_model(name="risk", kind, metadata)` into the `models`
  table — architecture, hparams, classes, metrics, confusion, `featureFilter`,
  `trainedUpTo`, `datasetRows`, `fineTuned`.

## 9b. Runtime config, feature filter, cron, meta

- `RuntimeConfig` overlays a durable `config` doc (single-row JSON in the `config` table) over env defaults.
  Everything in §5/§8 (ewmaDecay, contextWindows, pcaComponents, watchZ, highZ, featureFilter) plus all training
  hps and the `cron` schedule is tunable live via `PUT /v1/analytics/config` without a restart.
- `featureFilter[10]` masks the feature vector **before** EWMA/PCA. Changing the filter (or decay/context) resets the
  reference and context so analysis stays consistent on the filtered subset.
- `cron.py::Cron` is a standard **5-field** matcher (minute hour dom month dow, UTC) with `*/n`, `a-b`, lists and
  `next_run_ms()`. A daemon thread checks every 30s and starts training on match.
- `GET /v1/analytics/meta` returns meta metrics for the dashboard: live per-window **input vector** + filter mask,
  **PCA thresholds**, system snapshot (cpu/mem/temp/disk), model size/activity, and latency (`nnRuns`, last NN &
  PCA compute ms).
- `POST /v1/analytics/infer` runs manual TFLite inference on the latest stored window (bypassing sampling).

## 10. Environment (`PRD §11`)

`INGEST_SECRET`, `ANALYTICS_URL`, `ANALYTICS_GATEWAY_URL`, `ANALYTICS_PORT`, `REDIS_URL`,
`ANALYTICS_DB_FILE`, `ANALYTICS_FEATURE_WINDOW_SEC`, `ANALYTICS_CONTEXT_WINDOWS`,
`ANALYTICS_EWMA_DECAY`, `ANALYTICS_PCA_COMPONENTS`, `ANALYTICS_PCA_WATCH_Z`,
`ANALYTICS_PCA_HIGH_Z`, `ANALYTICS_ML_DIR`, `ANALYTICS_TRAIN_MIN_ROWS`,
`ANALYTICS_TRAIN_EPOCHS`, `ANALYTICS_TRAIN_BATCH`, `ANALYTICS_TRAIN_TRIALS`,
`ANALYTICS_TRAIN_VALIDATION`, `ANALYTICS_TRAIN_SEED`, `ANALYTICS_EMBED_ENABLED`.

## 11. Deferred items

- Full SSE replay/event-log + `analytics.drift` streaming loop.
- Training-data JSONL/CSV export endpoint + artifact versioning.
- Redis-escrow handoff for the gateway ingest backlog (in-memory bounded backlog today).
- Drift via PSI/KL/KS/MMD, loading-shift, lookalikes (+ sqlite-vec embeddings).
- Qwen3 thinking-share feature (explicit approval required).
- Per-request live scoring at high RPS (would revisit C++ serving — not needed at 60s cadence).

## 12. UI surface (gateway `public/index.html`)

- **ML Analytics page** (`ml-analytics`, sidebar under Tools): risk scorecard (risk level,
  Hotelling T² / p-value, compute·nn ms, windows scored, input→TF rows), a **docs & flow panel**
  (visual pipeline flowchart + links to this doc), 3D PCA explorer (square-ish canvas, light
  gridlines, viridis dot coloring by max|z| with gradient key, drag rotate / wheel zoom / hover
  inspect / click pin, dim cycling, tooltip shows window count = sample size), drift·T² bar
  history, per-feature z box-plots (rotated readable x labels + numeric y σ gridlines,
  current-window diamond), telemetry sparklines in one row (T², compute ms, nn ms, F1, rows),
  full-width training panel (state, rows/min, run, trials·epochs, artifacts, best model, per-trial
  log, Run training / Infer / Rebaseline / Refresh meta, run history table), models table,
  and the config panel (**context windows = Qwen model `--ctx-size`, read-only** — analyzer
  window count is fixed by `ANALYTICS_CONTEXT_WINDOWS`; removed the old editable `cfgCtx`).
- **Pipelines page:** each pipeline card (inference, model update, warehouse, TF training)
  carries its own live mini-stream of the relevant WS events plus note field.
- **Dashboard:** compact ML scorecard + a working **Live activity** event log (history
  backfilled from `/api/logs`, Clear button, routes request/analytics/training/model events).
- All pages log via the tagged log widget; logs filter by level **and source** (All / ML /
  Requests / System); `analytics.*` / `training.*` rows carry the `ml` tag.
- Metrics page adds ML telemetry sparks (labeled rows, windows, requests, tflite size) fed by
  the 5s refresh; per-page statusbar segments exist for every view; compact row-level mode is
  the default (`piCompact`).
- Connections: quick-sync button on every card + **ML artifact store** card (`/opt/qwen-ml`);
  Warehouse raw views show **labeled features + z**; Storage shows SQLite path, raw counts,
  artifacts and a ✓/✗ persistence list; Documents lists the analytics API surface + env vars.
- Live push via the gateway WebSocket: `analytics.risk` / `analytics.infer` refresh the ML page,
  `training.progress` / `training.done` / `training.started` / `training.error` refresh the
  training panel (+ stream to the pipeline mini-logs).
- TF write-back semantics: writing back the trained net's predictions as telemetry only — it does **not**
  relabel stored windows (no feedback loop into training labels).