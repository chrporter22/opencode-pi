# Analytics & risk layer architecture

- **Date:** 2026-09-05
- **Developer:** opencode
- **Topic:** gateway — analytics microservice (data-science / ML layer)
- **Status:** planned (docs only; no code yet)

## Decision

The analytics/risk layer is a **separate Python microservice** (`analytics/`, port 8081) in
this repo, not code inside the gateway. Decisions confirmed in-session:

1. **Language** — Python (FastAPI) running TFLite + scipy. Reasoning: TFLite compute is
   already C++; per-call binding overhead is negligible at a 60s-window cadence, and
   training/quantization is a Python-only workflow. C++ deferred unless profiling demands it.
2. **Placement** — new `analytics/` folder + Compose service (easily split into its own repo later).
3. **Redis** — full footprint: validated-key cache, per-key rate-limit counters, ingest
   escrow queue, shared live-score cache.
4. **Reference baseline** — adaptive EWMA (μ, σ, PCA loadings decay; risk = drift from
   recent norm), with a manual re-fit endpoint.
5. **Scoring granularity** — windowed drift for historic analysis; per-request features feed
   the live serving path via the ingest webhook.
6. **Context windows** — yes; last-N windows (default 12 ≈ 12 min) per feature feed the model.
7. **Live transport — gateway fan-out** — analytics POSTs scores to a gateway endpoint; the
   gateway broadcasts `analytics.risk` / `analytics.drift` over the existing admin `/ws`
   (one socket, one auth story). Rejected: direct SSE/WS from analytics (second socket, CORS, second auth).
8. **Ingest cadence** — deferred/TBD; bounded Redis escrow on outage (no inference backpressure, no loss at rest).
9. **Training-data endpoints** — both: `GET /v1/analytics/training/export` (shared secret)
   AND admin proxy `GET /api/analytics/training/export`, plus raw `GET /v1/analytics/historic/windows`.
10. **Telemetry rule** — numeric-only everywhere (no prompt/response/reasoning content),
    preserving PRD §6.7 #33.

## Why

- Keep the gateway sync/lightweight; ML is a slow, decoupled concern. Runtime-decoupling
  means inference never blocks on analytics availability.
- Hotelling T² → exact F/χ² tail gives a principled "probability of being ≥1.5σ from the
  mean" (per-component two-tailed p ≈ 0.134, aggregated across k components).
- SQLite (+ `sqlite-vec`) is dependency-light on a Pi and enables historic lookback/lookalikes;
  Redis already fits the one-node footprint for keys/limits/queue/cache.
- Gateway fan-out reuses the existing authenticated WS and the system.metrics push pattern.

## Notes

- Documented in PRD §6.13 (#56–#65), §7.1/§7.3/§7.5, §11, §20; README "Analytics & risk
  layer"; full data contracts in `docs/analytics-layer.md`.
- TF-Lite NN is offline-trained and ships as artifacts (never baked into images); training is
  a deferred item.

## Relates to

- `2026-09-05--control-center-v2-scope.md` — numeric-only telemetry precedent (request ring).
- `docs/analytics-layer.md` — the authoritative data contracts.