# Analytics & Risk Layer — implementation plan (v2, refreshed 2026-09-06)

> v1 approved 2026-09-05 was docs-only (PRD/README/docs/analytics-layer/.ai). v2 encodes
> the revised architecture confirmed 2026-09-06: an ML serving layer with live WS + SSE,
> gateway-proxy-only access, a top-3-PCA ±1.5σ label rule, storage/mount changes
> (`/opt/qwen-ml`, external SQLite, warehoused Redis), in-app training, and an
> orchestrator-style control center. Still no code — implementation is a later session.

## Goal

Add a data-science/ML layer to opencode-pi as a **separate Python microservice**
(`analytics/`, port 8081, internal to compose) fed by the gateway via a webhook. It
performs: context-window feature engineering, **live serving** (re-score every new
window), PCA eigen-decomposition + a top-3-PC **±1.5σ risk label**, historic drift
analysis, lookalike search over two vector stores, TFLite NN inference (artifacts
trained in-repo), backed by external-mount **SQLite** (+ `sqlite-vec`) and warehoused
**Redis**. Live ML results reach the Control Center via gateway fan-out over the existing
admin WebSocket **and** via an SSE stream proxied by the gateway.

## Decisions (all confirmed via clarifying questions / plan approval)

- **Language:** Python (FastAPI) + TFLite (native C++ compute) + scipy. The numeric kernel
  is written to be **portable to C++ later** (well-specified math routines, transportable
  storage schema, no Python-only state in the hot path) for better memory allocation.
- **Placement:** new `analytics/` folder + `analytics`, `analytics-train`, and `redis`
  compose services (split into its own repo later if needed).
- **Access = gateway proxy only.** External Qwen project + UI use admin-proxied
  `/api/analytics/*` on `:8080`. `:8081` stays internal; only `8080:8080` published.
  Gateway + analytics containers are the source of truth. SQLite file is container-local
  on an external mount — never shared as a raw network file.
- **ML serving layer.** Analytics re-scores every new window live from SQLite (+ Redis
  `score:latest`) and serves results two ways: (1) WS fan-out — analytics POSTs scores to
  the gateway, gateway broadcasts `analytics.*` over admin `/ws`; (2) **SSE** — `GET
  /v1/analytics/stream` (shared secret, internal) proxied as `GET /api/analytics/stream`
  (admin key) for the UI and the external Qwen client. Everything analytics surfaces is
  live-update-capable.
- **Label rule.** Top-3 PCA components vs the adaptive EWMA reference: any PC
  `z ≤ −1.5 or z ≥ +1.5` ⇒ **high risk** (direction-aware); `|z|∈[1.0,1.5)` ⇒ watch; else
  normal. Labels recompute live per window and are the training target.
- **PCA.** `k = min(6, …)` components (`ANALYTICS_PCA_COMPONENTS=6`) on the current
  rolling context window; per-window eigenvalues + per-feature loadings stored; UI cycles
  PC1–PC6, shows per-feature top loading, highlights/filters by risk label.
- **Redis:** full footprint — validated-key cache + per-key rate-limit counters (deferred
  from v1 serving scope), ingest escrow queue, shared live-score cache. **Warehoused**:
  compose volume + appendonly persistence; keys/types/TTL visible in the UI Warehouse.
- **Reference baseline:** adaptive EWMA (μ, σ, PCA loadings decay slowly) — "risk = drift
  from the recent norm", with a manual re-fit endpoint.
- **Scoring granularity:** windowed scoring for historic analysis + live serving path;
  per-request features feed the live path via the webhook.
- **Context windows:** yes — last-N windows (default 12 ≈ up to 12 min) per feature.
- **Embeddings split.** `feature_vec`/`context` feed PCA/risk only. Lookalikes use two
  `sqlite-vec` stores, both excluded from PCA/risk: learned numeric embedding (NN head)
  + semantic embedding (transformer over content-free numeric window encoding; preserves
  the no-content rule).
- **Storage/mounts.** ML artifacts (TFLite, checkpoints) on host `/opt/qwen-ml`, mounted
  into `analytics` + `analytics-train` (model-as-data extended). SQLite db on an external
  mount. Redis warehoused (volume).
- **Training (in-app).** `analytics-train` service (no exposed port), startable from the
  UI, invoked by `analytics` via API; trains/quantizes TFLite NN from labeled export →
  `/opt/qwen-ml`; `analytics` hot-reloads artifacts; TFLite serving live once artifact #1
  exists.
- **Ingest cadence:** still TBD (bounded Redis escrow on outage; no inference
  backpressure).
- **UI → orchestrator.** See the v1 → UI section below (§§).
- **Telemetry rule:** numeric-only everywhere (no prompt/response/reasoning content),
  preserving PRD §6.7 #33.

## Architecture

```
Control Center (browser) ──WS /ws + SSE /api/analytics/stream──▶ gateway :8080 (TS, admin)
                                      │ webhook POST /v1/analytics/ingest (batched, bounded Redis escrow)
                                      ▼
                           analytics :8081 (Python FastAPI + TFLite + scipy)  [internal only]
                           ├─ feature + context-window builder (60s windows, last-N context)
                           ├─ ML serving layer: re-score every new window live (SQLite + Redis cache)
                           ├─ PCA eigensystem (adaptive EWMA reference) + top-3-PC ±1.5σ label
                           ├─ drift detection (feature PSI, KS/MMD on PC scores, loading shift)
                           ├─ TF-Lite NN (context → risk/drift probabilities)   [artifact ≥1]
                           ├─ SQLite + sqlite-vec store (features + 2 embedding stores + PCs)
                           ├─ Redis (key cache, ingest escrow, score cache, warehouse)
                           └─ SSE stream /v1/analytics/stream → gateway proxy → UI/external
           analytics :8081 ◀── POST /v1/analytics/training/start (invoked from UI via gateway)
                           analytics-train :0 (no port) → /opt/qwen-ml artifacts → analytics hot-reload
```

- Gateway → analytics: `POST /v1/analytics/ingest` (shared secret `INGEST_SECRET`;
  batches queue in Redis on outage — bounded escrow, flush on reconnect, no backpressure).
- Analytics → gateway: `POST /v1/analytics/scores` → gateway broadcasts over `/ws`;
  `GET /v1/analytics/stream` → gateway proxies as `GET /api/analytics/stream` (SSE).
- UI + external Qwen project: `GET /api/analytics/risk`, `/pca`, `/drift/historic`,
  `/historic/lookalikes`, `/pipelines`, `/warehouse/sql`, `/warehouse/redis`,
  `/training/status`, `POST /api/analytics/training/start`, `POST .../test-dashboard`

## Feature set (numeric-only)

Per-request: `log prompt/completion/total tokens`, `tok/s`, `log durationMs`, error-binary.
Window: `requestsPerMinute`, error rate, p95/p99 latency + tok/s.
System context at inference time: cpu %, mem %, temperature, disk %, thermal ramp.
Planned numeric additions: `timeToFirstToken`; Qwen3 thinking-share (pending explicit approval).

## Risk model (top-3-PC ±1.5σ rule)

- Standardize vs adaptive EWMA reference; PCA on the current rolling window, up to 6 comps.
- For each of the top 3 components compute `zᵢ = scoreᵢ/σ`. **Label high risk when any
  `zᵢ ≤ −1.5 or zᵢ ≥ +1.5`**; watch when `1.0 ≤ |zᵢ| < 1.5`; normal otherwise. Live per-window.
- Drift flags: feature PSI (>0.2 alert), KS/MMD p-value on PC scores, loading shift.

## UI → orchestrator (delta from v1)

- **Dashboard:** existing cards + quick **Test connection** / **Sync now** buttons per
  connection (gateway, llama, analytics, redis, sqlite, webhook, external Qwen).
- **Analytics card:** ML results (risk, PCA, drift, lookalikes) + **ML service details** —
  per-window **compute time (ms)**, service **temperature** (Pi temp source), ML process
  CPU/mem; **dynamic PC1–PC6 plot**, per-feature top-loading, highlight/filter by label.
- **Connections:** gateway · analytics · redis · **sql** (sqlite) · **pipelines**, with
  endpoint details, health, mini metrics; **add/edit connection metadata** from the UI.
- **Pipelines:** training, webhook (ingest/score-push), and **live WebSocket clients as
  pipelines**; each lists **usable endpoints**, events/sec, bytes, last-seen, status; UI
  can **register new pipelines** (persisted in the warehouse config).
- **Warehouse:** SQL view (tables, columns, schema, row counts, raw columns, db size) +
  Redis view (keys, types, TTL, memory, persistence).
- **Logs:** existing ring + incoming **webhook** entries (`analytics.webhook`).
- **Documents / How-to-use** pages.

## Endpoints (v1 + new)

- Analytics (§7.3): `POST /v1/analytics/ingest`, `POST /v1/analytics/scores`,
  `POST /v1/analytics/rebaseline`, `GET /v1/analytics/health`,
  `GET /v1/analytics/training/export`, `GET /v1/analytics/historic/windows`,
  **`GET /v1/analytics/stream` (SSE)**, **`GET /v1/analytics/pca`**,
  **`GET /v1/analytics/lookalikes`**, **`POST /v1/analytics/training/start`**,
  **`GET /v1/analytics/training/status`**, **`GET /v1/analytics/warehouse/sql`**,
  **`GET /v1/analytics/warehouse/redis`**, **`GET /v1/analytics/pipelines`**,
  **`POST /v1/analytics/pipelines`**.
- Gateway proxies (§7.1, admin): mirror of the above under `/api/analytics/*` +
  `/api/analytics/stream`.

## WebSocket events (expanded)

`analytics.risk`, `analytics.drift`, `analytics.pca`, `training.started/progress/done/error`,
`pipeline.*`, `store.window`/`store.request`, `analytics.webhook`. Carried over the existing
admin `/ws`; SSE stream carries the same `analytics.*`/`store.*` payloads for EventSource
clients.

## Env additions (PRD §11)

`ANALYTICS_ML_DIR=/opt/qwen-ml`, `ANALYTICS_DB_FILE`, `ANALYTICS_PCA_COMPONENTS=6`,
`ANALYTICS_PCA_WATCH_Z=1.0`, `ANALYTICS_PCA_HIGH_Z=1.5`, `ANALYTICS_EMBED_ENABLED`,
`ANALYTICS_EMBED_MODEL`, `ANALYTICS_TRAIN_URL`, `REDIS_PERSISTENT=true` (plus existing
`ANALYTICS_PORT`, `ANALYTICS_URL`, `INGEST_SECRET`, `REDIS_URL`,
`ANALYTICS_FEATURE_WINDOW_SEC`, `ANALYTICS_CONTEXT_WINDOWS`, `ANALYTICS_EWMA_DECAY`).

## Compose topology (delta)

`analytics` (:8081, internal), `analytics-train` (no port, on-demand),
`redis` (internal, volume). Volumes: `/opt/qwen-ml` (artifacts), sqlite state file
(external mount), `redis-data`. Only `8080:8080` published.

## Deliverables on approval (docs refresh — DONE 2026-09-06)

1. `PRD.md` — §6.13 rewritten (append #66+), §7.1/§7.3/§7.4 API tables, §8 WS + SSE events,
   §9 UI sections, §11 env, §18.1 compose, §20 acceptance.
2. `README.md` — architecture diagram + Analytics section + status.
3. `.ai` — decision + session files.
4. This plan refreshed to v2.

## Next milestone (implementation, not started)

Ordered subtasks for a future session: analytics service scaffold (FastAPI + health +
config) → warehouse (SQLite schema + Redis) → ingest webhook + escrow → windowing/EWMA
reference → PCA + top-3 label → drift → serving layer (WS push + SSE) → gateway proxies +
WS fan-out → analytics-train service + artifact reload → UI orchestrator sections →
end-to-end verification on the Pi.