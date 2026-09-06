# Analytics & risk layer refresh — serving layer, SSE, label rule, orchestrator UI

- **Date:** 2026-09-06
- **Decided by:** user (confirmed in-session via clarifying questions + plan approval)
- **Topic:** gateway
- **Status:** documented (docs/PRD/README/.opencode plan refreshed; no code yet)

## Context

This revises `2026-09-05--analytics-and-risk-layer-architecture.md` (append-only: that
file stands; this one records the new layer on top). The earlier decision scoped a
Python FastAPI analytics service on `:8081` with a shared-secret surface, deferred
training, and a gateway `/ws` fan-out only.

## Decision

The analytics & risk layer is redesigned as follows (all user-confirmed):

1. **ML serving layer.** Analytics is a live serving system, not a batch scorer: it
   re-scores every new window from SQLite (+ Redis `score:latest`) and serves results
   two ways — WebSocket fan-out (analytics → gateway → admin `/ws` → UI) and **SSE**
   (`GET /v1/analytics/stream` internal, proxied as `GET /api/analytics/stream` on :8080).
   Everything analytics surfaces must be live-update-capable (WS or SSE).
2. **Access = gateway proxy only.** The external Qwen project and the UI reach analytics
   data exclusively through admin-proxied `/api/analytics/*` on the gateway `:8080`.
   `:8081` stays internal to the compose network; only `8080:8080` is published. SQLite
   stays container-local on an external mount — never shared as a raw file over the
   network. Gateway + analytics together form the source of truth.
3. **Label rule (PCA 1–3 vs EWMA reference).** Risk labels are derived from the **top 3**
   principal components' standardized values against the adaptive EWMA window: **any PC
   `z ≤ −1.5 or z ≥ +1.5` ⇒ high risk** (direction-aware: negative and positive both
   trip); `|z| ∈ [1.0, 1.5)` ⇒ watch; otherwise normal. Labels recompute live on each new
   window and double as the training target.
4. **PCA.** Retain up to `min(6)` components (`ANALYTICS_PCA_COMPONENTS=6`), computed on
   the current rolling context window. Each window stores its principal components,
   eigenvalues, and per-feature loadings; the UI cycles PC1–PC6 in a dynamic plot, shows
   each feature's top loading, and highlights/filters by risk label.
5. **Embeddings split.** `feature_vec` + `context` feed PCA/risk only. Lookalikes use two
   vector stores in `sqlite-vec`, both excluded from PCA/risk: a **learned numeric
   embedding** (NN embedding head) and a **semantic embedding** (transformer embedder over
   a canonical, content-free numeric window encoding — preserves the no-content rule).
6. **Storage.** ML artifacts (TFLite, checkpoints) live on the host at `/opt/qwen-ml` and
   are mounted into the `analytics` and `analytics-train` containers (model-as-data
   convention extended). The SQLite db file is on an external mount (survives container
   recreation). Redis is **warehoused**: compose volume + appendonly persistence, and its
   keys/types/TTL are visible in the UI Warehouse view alongside the SQLite schema.
7. **Training pipeline (in-app).** A compose service `analytics-train` (no exposed port)
   is startable from the UI and invoked by `analytics` via API. It trains/quantizes the
   TFLite NN from the labeled window export, writes artifacts to `/opt/qwen-ml`, and
   `analytics` hot-reloads new artifacts; TFLite serving goes live once artifact #1
   exists. The Python numeric kernel is scoped to port to C++ later (portable kernels,
   transportable storage schema, no Python-only state in the hot path) for better memory
   allocation.
8. **UI → orchestrator.** The single-file control center grows sections: Dashboard (with
   quick **test/sync** buttons on every connection), Analytics card (ML results,
   per-window **compute time**, service **temperature**, ML process CPU/mem, PC plot),
   Connections (gateway/analytics/redis/sqlite/webhook/external Qwen with endpoint
   details, health, mini metrics, add/edit metadata), Pipelines (training, webhook, and
   live WebSocket clients as pipelines with usable endpoints, events/sec, bytes,
   last-seen, status, **and UI-registered new pipelines**), Warehouse (SQL tables/columns/
   schema/row counts/raw columns + Redis keys/types/TTL/memory), Logs (including incoming
   **webhook** entries), Documents, and How-to-use.
9. **Docs-first ordering.** All of the above was captured in docs/PRD/README/.opencode
   plan and `.ai` memory before any implementation. Code follows in a later session.

## Why

- "Live connection" + "everything live update" requirement makes a serving layer + SSE
  the natural transport; SSE reuses the existing gateway auth boundary and works for the
  external Qwen client through the same admin proxy.
- Gateway-proxy-only preserves the single-exposed-port security model (§6.2 #6, §6.7 #34)
  while still exporting analytics to external consumers.
- A signed, direction-aware ±1.5σ rule on the top-3 PCs gives the simple, asymmetric
  high-risk signal the user asked for, with watch as a softer band and normal otherwise.
- The embeddings split keeps semantic lookalikes independent of the statistical risk
  model — different purposes, different math, same store.
- The user explicitly asked for train-in-app and a C++-portable Python kernel, so both
  are recorded requirements rather than open options.

## Supersedes / relates to

- Supersedes parts of `2026-09-05--analytics-and-risk-layer-architecture.md` (kept as
  history; this file is the revision).
- Relates to `2026-09-05--control-center-v2-scope.md` (numeric-only telemetry precedent),
  `2026-09-05--build-phasing-and-framework-choices.md`, and `docs/analytics-layer.md`.

## Notes

- New env vars added to PRD §11: `ANALYTICS_ML_DIR`, `ANALYTICS_DB_FILE`,
  `ANALYTICS_PCA_COMPONENTS`, `ANALYTICS_PCA_WATCH_Z`, `ANALYTICS_PCA_HIGH_Z`,
  `ANALYTICS_EMBED_ENABLED`, `ANALYTICS_EMBED_MODEL`, `ANALYTICS_TRAIN_URL`,
  `REDIS_PERSISTENT`.
- Compose gains `analytics`, `analytics-train`, `redis` services and `/opt/qwen-ml`,
  sqlite-state, and `redis-data` volumes; only `8080:8080` remains published.
- Deferred items unchanged and still open: ingest push cadence (TBD), transformer-embedder
  choice/quant, SSE/WS transport detail, TFLite artifact v1, C++ port timing.