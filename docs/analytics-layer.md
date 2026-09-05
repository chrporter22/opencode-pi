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
| POST   | `/v1/analytics/ingest` | Batched feature ingestion from gateway |
| POST   | `/v1/analytics/scores` | Push latest score to gateway (internal) |
| POST   | `/v1/analytics/rebaseline` | Manual re-fit / reset of EWMA+PCA reference |
| GET    | `/v1/analytics/health` | Liveness (no auth) |
| GET    | `/v1/analytics/training/export` | Labeled training-data export |
| GET    | `/v1/analytics/historic/windows` | Paged raw window + embedding records |

### 7.2 Gateway proxy (`/api/*`, admin key) — proxied to analytics

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/analytics/risk` | Latest `{ t2, pValue, level, components }` |
| GET    | `/api/analytics/drift/historic` | Drift series (`{ from, to, features, ks, mmd, psi }`) |
| GET    | `/api/analytics/historic/lookalikes` | Nearest historic windows by embedding |
| GET    | `/api/analytics/training/export` | Same as 7.1 export, behind admin key |

### 7.3 WebSocket fan-out

`analytics.risk` / `analytics.drift` events broadcast by the gateway (existing admin `/ws`),
payload `{ type, timestamp, level, t2, pValue, components?, drift? }`.

## 8. Training-data export

- Endpoint: `GET /v1/analytics/training/export?format=jsonl|csv&from=&to=&limit=`
  (and the gateway proxy in 7.2).
- Each record (JSONL line / CSV row):
  ```
  { window_start, features:[...], context:[last-N x P],
    pcs:[...], risk:{ t2, p_value, level },
    label: "normal" | "watch" | "high" }
  ```
- `label` auto-derived from the risk model at export time (the target the TFLite NN is
  trained to predict from `features`/`context`). Raw paging: `GET /v1/analytics/historic/windows`.
- Offline fallback: direct `sqlite3` dump of `windows`/`requests` tables.

## 9. Model artifacts

- TFLite model (`context → {risk_prob, drift_prob, levels}`) trained offline; artifacts land
  in `analytics/models/*.tflite` and ship as files (never baked into images).
- Training uses the labeled window export (§8); quantization (int8/float16) follows the
  Pi-5 TFLite runtime.

## 10. Environment (`PRD §11`)

`ANALYTICS_PORT`, `ANALYTICS_URL`, `INGEST_SECRET`, `REDIS_URL`,
`ANALYTICS_FEATURE_WINDOW_SEC`, `ANALYTICS_CONTEXT_WINDOWS`, `ANALYTICS_EWMA_DECAY`.

## 11. Deferred items

- Ingest push cadence (gateway → analytics) — TBD.
- TFLite training pipeline & artifact versioning.
- Qwen3 thinking-share feature (explicit approval required).
- Per-request live scoring at high RPS (would revisit C++ serving — not needed at 60s cadence).