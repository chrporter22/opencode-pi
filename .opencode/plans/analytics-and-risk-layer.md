# Analytics & Risk Layer — implementation plan (approved 2026-09-05)

## Goal

Add a data-science/ML layer to opencode-pi. **It is a separate Python microservice** in this
repo (`analytics/`, port 8081), fed by the gateway via a webhook. It performs: context-window
feature engineering, TF-Lite neural net inference (risk/drift), PCA eigen-decomposition +
1.5σ risk model, historic drift analysis backed by a **SQLite vector/embedding store**, with
**Redis** for key cache / rate limits / ingest escrow / live-score cache. Live ML results reach
the Control Center via **gateway fan-out** over the existing admin WebSocket.

## Decisions (all confirmed via clarifying questions)

- **Language:** Python (FastAPI) service running TFLite (compute is natively C++) + scipy for
  PCA. C++ deferred: irrelevant at 60s-window cadence; training/quantization is Python-only anyway.
- **Placement:** new `analytics/` folder + service in this repo's docker-compose (split into
  its own repo later if needed).
- **Redis:** full footprint (keys, rate-limit counters, ingest escrow queue, live-score cache).
- **Reference baseline:** adaptive EWMA (μ, σ, PCA loadings decay slowly) — "risk = drift from
  the recent norm".
- **Scoring granularity:** windowed drift for historic analysis + live serving path (webhook
  ingest on incoming inference); per-request features feed the live path.
- **Context windows:** yes — last-N windows (default 12 ≈ up to 12 min) per feature feed the model.
- **Live transport:** gateway fan-out — analytics POSTs scores to a gateway endpoint; gateway
  broadcasts `analytics.risk` / `analytics.drift` over existing authed `/ws`. One socket, one auth.
- **Ingest cadence:** deferred (TBD) — leave a placeholder in docs.
- **Telemetry rule:** numeric-only everywhere (no prompt/response/reasoning content), preserving PRD §6.7 #33.

## Architecture

```
Control Center (browser) ──WS──▶ gateway :8080 (TS)
                                     │ webhook POST /v1/analytics/ingest (batched, bounded Redis escrow)
                                     ▼
                          analytics :8081 (Python FastAPI + TFLite + scipy)
                          ├─ feature + context-window builder (60s windows, last-N context)
                          ├─ PCA eigensystem (adaptive EWMA reference) + risk scoring
                          ├─ TF-Lite NN (context window → risk/drift probabilities)
                          ├─ drift detection (feature PSI, KS/MMD on PC scores, loading shift)
                          ├─ SQLite + sqlite-vec store (request & window rows + embeddings)
                          └─ Redis (key cache, rate-limit counters, ingest escrow, score cache)
```

- Gateway → analytics: `POST /v1/analytics/ingest` (shared secret `INGEST_SECRET`); batches
  queue in Redis on outage (bounded escrow, flush on reconnect; no inference backpressure).
- Analytics → gateway: `POST /v1/analytics/scores` → gateway broadcasts over `/ws`.
- UI: `GET /api/analytics/risk`, `/api/analytics/drift/historic`,
  `/api/analytics/historic/lookalikes` (admin-proxied).

## Feature set (numeric-only)

Per-request: `log prompt/completion/total tokens`, `tok/s`, `log durationMs`, error-binary.
Window: `requestsPerMinute`, error rate, p95/p99 latency + tok/s.
System context at inference time: cpu %, mem %, temperature, disk %, thermal ramp.
Planned numeric additions: `timeToFirstToken`; Qwen3 thinking-share (pending explicit approval).

## Risk model (the 1.5σ part)

- Standardize vs adaptive EWMA reference; PCA on reference (k comps ~95% var).
- Live score = Hotelling T² of standardized scores → exact F/χ² tail probability.
- "≥1.5σ" per component = two-tailed normal tail p ≈ 0.134; aggregate across k.
- Levels: normal / watch (>1.5σ) / high. Drift: PSI + KS/MMD + loading shift.

## Deliverables on approval

1. **PRD** — new §6.13 "Analytics & risk layer" (#56–#65 as drafted), §7.1 gateway analytics
   proxy rows, new §7.3 "Analytics API" table (rename current 7.3/7.4 → 7.4/7.5), §11 env
   table (`ANALYTICS_PORT`, `ANALYTICS_URL`, `INGEST_SECRET`, `REDIS_URL`,
   `ANALYTICS_FEATURE_WINDOW_SEC`, `ANALYTICS_CONTEXT_WINDOWS`, `ANALYTICS_EWMA_DECAY`),
   §20 acceptance "Analytics & risk layer" block.
2. **README** — architecture diagram + "Analytics & risk layer" section.
3. **docs/analytics-layer.md** — full data contracts (feature/key/embedding schema,
   gateway↔analytics↔Redis↔SQLite payloads), component roles, deferred cadence + model-training notes.
4. **`.ai` memory** — decision file + session file in `.ai/decisions/gateway/` and `.ai/sessions/gateway/`.