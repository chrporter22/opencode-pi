# Analytics & risk layer — docs/PRD/plan refresh

- **Date:** 2026-09-06 18:13
- **Developer:** opencode (big-pickle)
- **Topic:** gateway
- **Preceding:** 2026-09-05 (analytics plan approval, docs only). This session is
  planning/documentation only — no code changed.

## Request

"Start planning to update the analytics project." Clarified in-session to a **docs
refresh first**: update `.opencode/plan`, `PRD.md`, `README.md`, and `.ai/` to encode the
revised analytics & risk layer architecture; no implementation. User expanded the design
significantly via clarifying questions and then approved the v3 plan for writes.

## What was done

Docs rewritten/refreshed across four surfaces (see "Files touched" below). New/changed
scope encoded:

- **ML serving layer** as a named component: analytics re-scores every new window live
  from SQLite (+ Redis `score:latest`) and serves results over WS fan-out AND SSE.
- **Access = gateway proxy only.** External Qwen project + UI reach analytics through
  admin-proxied `/api/analytics/*` on `:8080`; `:8081` stays internal to compose; only
  `8080:8080` published. SQLite file stays container-local on an external mount.
- **Label rule.** Top-3 PCA components vs the adaptive EWMA reference: any PC
  `z ≤ −1.5 or z ≥ +1.5` ⇒ **high risk** (direction-aware, both sides); `|z|` in
  `[1.0, 1.5)` ⇒ watch; else normal. Labels recomputed live and reused as the training
  target.
- **PCA.** `k = min(6, …)` components on the current rolling context window; per-window
  eigenvalues + per-feature loadings stored; UI cycles PC1–PC6, shows top loading per
  feature, highlights/filters by risk label.
- **Embeddings split.** Learned numeric embedding (NN head) + semantic embedding
  (transformer over content-free numeric window encoding) in separate `sqlite-vec`
  stores; neither enters PCA/risk.
- **Storage.** ML artifacts in host `/opt/qwen-ml` (mounted into analytics +
  analytics-train); SQLite external file mount; Redis persisted via compose volume
  (appendonly), surfaced as a Warehouse view.
- **In-app training pipeline.** `analytics-train` compose service, UI-startable, invoked
  by `analytics`; trains/quantizes TFLite NN from the labeled export → `/opt/qwen-ml`;
  analytics hot-reloads; TFLite serving goes live once artifact #1 exists. Python kernels
  scoped for a future C++ port.
- **UI → orchestrator.** Dashboard (+ test/sync buttons per connection), Analytics card
  (ML results + per-window compute time, service temperature, ML process CPU/mem, PC
  plot), Connections (gateway/analytics/redis/sqlite/webhook/external Qwen with endpoint
  details + mini metrics + add/edit), Pipelines (training, webhook, live WS clients;
  usable endpoints; add pipelines; events/sec/bytes/last-seen/status), Warehouse (SQL +
  Redis schema/keys), Logs (+ incoming webhook entries), Documents, How-to-use.
- **SSE + WS live everywhere.** New SSE endpoints (`/v1/analytics/stream` internal,
  `/api/analytics/stream` admin proxy); expanded WS event set (`analytics.risk`,
  `analytics.drift`, `analytics.pca`, `training.*`, `pipeline.*`, `store.window/request`,
  `analytics.webhook`).
- New env vars: `ANALYTICS_ML_DIR`, `ANALYTICS_DB_FILE`, `ANALYTICS_PCA_COMPONENTS=6`,
  `ANALYTICS_PCA_WATCH_Z`, `ANALYTICS_PCA_HIGH_Z`, `ANALYTICS_EMBED_ENABLED`,
  `ANALYTICS_EMBED_MODEL`, `ANALYTICS_TRAIN_URL`, `REDIS_PERSISTENT`.

## Notable findings

- Existing analytics docs (`PRD §6.13`, `docs/analytics-layer.md`, README, the approved
  `.opencode/plans/analytics-and-risk-layer.md`) described a simpler Python FastAPI
  service with deferred training, `:8081` "shared secret" surface, TBD ingress, and no
  serving/SSE/orchestrator-UI layer. The revision substantially grows scope in one
  direction: a live, gateway-proxied, orchestrator-style analytics system.
- Keeping `:8081` internal (gateway-proxy-only access) preserves the PRD boundary rule
  "only 8080 exposed" (§6.2 #6, §6.7 #34) — the earlier docs left `:8081/*` as a
  shared-secret surface reachable how/from-where-open.
- PRD numbering: new requirements appended as #66+ to avoid renumbering #56–65 (stable
  references in other docs).
- `docs/analytics-layer.md` is the authoritative data contract per the decision file;
  PRD summarizes, README summarizes further, `.opencode/plan` is the implementation plan.

## Open threads

- All analytics code is still unimplemented (README status checkbox remains unchecked
  with a "(planned)"/"(docs refreshed)" note).
- Deferred items kept open in docs: gateway→analytics ingest push cadence (TBD),
  transformer-embedder model choice/quantization, SSE/WS transport detail, TFLite
  artifact v1, C++ port timing.
- `docs/analytics-layer.md` was deliberately **NOT** updated this session (not in the
  approved deliverable list). It now lags the PRD §6.13/§7.3/§8 wording — next session
  should sync the contract doc (serving layer, SSE, top-3-PC label, split embedding
  stores, `/opt/qwen-ml`, warehoused Redis, analytics-train, orchestrator UI) with the
  PRD v3 before implementation.

## Files touched

- `.ai/sessions/gateway/2026-09-06-1813--analytics-layer-docs-refresh.md` (this file)
- `.ai/decisions/gateway/2026-09-06--analytics-layer-docs-refresh.md`
- `.opencode/plans/analytics-and-risk-layer.md`
- `PRD.md`
- `README.md`