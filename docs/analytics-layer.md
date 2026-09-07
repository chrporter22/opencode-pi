# Analytics & Risk Layer — design

Status: **planned** (PRD §6.13 #56–#65). This document is the data contract for the
analytics microservice. Implementation is tracked separately.

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
(`features` — 1D) plus `context` (last-N × P matrix). The TFLite model consumes `context`;
the PCA risk scorer consumes the single latest window's `features`.

## 4. Data / normalization / reference

1. Windows are standardized against the EWMA reference: `z = (x − μ_ref) / σ_ref`.
2. The reference updates per window with decay `ANALYTICS_EWMA_DECAY`:
   `μ ← (1−α)·μ + α·x`, `S ← (1−α)·S + α·x²` (σ from S−μ²), loadings via recomputed
   covariance eigen-decomposition at a lower decayed cadence.
3. PCA: `k` components retained ≈ 95% variance (min `max(1, floor(k_max*0.95_variance))`),
   computed on the decayed covariance (power iteration / QR; tiny P×P).

`POST /v1/analytics/rebaseline` recomputes the reference from stored windows (or reset).

## 5. Risk model

- Standardized scores → PC scores `y = L·z`.
- Hotelling `T² = Σᵢ (yᵢ/λᵢ)²` over retained components.
- Tail probability: `T²` scaled → `F(k, n−k)` (and `χ²(k)` asymptotically):
  `p = 1 − F_CDF(T²)`
- "≥1.5σ" rule: for one component the two-tailed normal tail is `p ≈ 0.1336`; combined over
  k components this is the multivariate threshold `sqrt(p·χ²)` equivalent — the UI renders
  the level as:
  - **normal** — recent `T²` within typical range (p > 0.05)
  - **watch** — >1.5σ: per-component `|zᵢ| > 1.5` on any component or `p < 0.05`
  - **high** — `p < 0.01` or a single component `|zᵢ| > 2.5`

Live outputs: `{ t2, pValue, level, components: [{i, loading, value, z}] }`.
Drift flags: feature PSI (>0.2 alert), KS/MMD p-value on PC scores, loading shift
cosine distance vs reference.

## 6. Storage

- **SQLite** `analytics.db`:
  - `windows(id, window_start, feature_vec BLOB, context BLOB, pcs BLOB, risk TEXT, t2 REAL, p_value REAL)`
  - `requests(id, started_at, feature_vec BLOB, embedding BLOB, error INTEGER)`
  - `reference(updated_at, mu BLOB, sigma BLOB, loadings BLOB, eigen BLOB)` (latest snapshot)
- **Vector index:** `sqlite-vec` virtual table over `windows.feature_vec` /
  `requests.embedding` for nearest-neighbor lookback (lookalikes).
- **Redis keys:**
  - `key:{hash}` → validated key record + TTL (key cache)
  - `rl:{hash}:{window}` → per-key request counter (rate limiting)
  - `pending:analytics:ingest` → bounded escrow list
  - `score:latest` → latest risk/drift JSON (shared gateway↔analytics)

## 7. API

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

## 8. Training-data export

- Each window in `windows` is auto-labeled `normal | watch | high` from the risk model at
  ingest time (`risk` column, stored with pcs/loadings/eigen). Training reads
  `training_features()` from those rows.
- Raw paging: `GET /v1/analytics/historic/windows`. Full labeled JSONL/CSV export
  (`/v1/analytics/training/export`) is a deferred enhancement; offline fallback remains a
  direct `sqlite3` dump of `windows`/`requests`.

## 9. Model artifacts

- Training runs **in-process** on the analytics service (lazy TF import): first build when
  rows ≥ `ANALYTICS_TRAIN_MIN_ROWS`, then open-and-fine-tune on every new write — storage is
  never wiped.
- Each run does `ANALYTICS_TRAIN_TRIALS` random-search hyperparameter trials
  (units/layers/dropout/lr/batch/epochs); every trial is stored in `training_runs`
  (`hp`, `metrics`, `confusion`, `best`) and streamed as a `training.progress` event.
- Per-trial **precision / recall / accuracy / F1** (per-class + macro) and the **3×3
  confusion matrix** are computed with pure-python mathlib utilities (no sklearn).
- Best model = best macro-F1 (fallback accuracy); exported to `/opt/qwen-ml` as
  `{model_name}.keras` (SavedModel) + `{model_name}.tflite` and announced via `training.done`.
- **Incremental fine-tune + watermark:** once a model exists, each run feeds `training_features(since=watermark)`
  (rows strictly newer than the last `trainedUpTo`), re-opens the SavedModel (`layer.trainable=True`), and advances
  the watermark to `training_max_window_start()`. No new rows → `training.skipped`.
- **Live TFLite classification** (`nn.py::TFLiteClassifier`): lazy TF import, caches the interpreter keyed on artifact
  mtime; the active risk model classifies each masked window `→ {nnRisk, nnProb, nnLatencyMs}` (sampled per the
  model's `sampling.windowEvery`), merged into the `analytics.risk` event. Manual run via `POST /v1/analytics/infer`.

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

- TFLite inference only surfaces when a trained risk model exists (currently `modelActive:false`,
  rows ≪ `ANALYTICS_TRAIN_MIN_ROWS`); live-classify is fully wired and verified end-to-end once trained.
- Full SSE replay/event-log + `analytics.drift` streaming loop.
- Training-data JSONL/CSV export endpoint + artifact versioning.
- Redis-escrow handoff for the gateway ingest backlog (in-memory bounded backlog today).
- Drift via PSI/KL/KS/MMD, loading-shift, lookalikes (+ sqlite-vec embeddings).
- Qwen3 thinking-share feature (explicit approval required).
- Per-request live scoring at high RPS (would revisit C++ serving — not needed at 60s cadence).