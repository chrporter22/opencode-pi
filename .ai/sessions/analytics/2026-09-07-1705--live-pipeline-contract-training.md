# Analytics: live pipeline, PcaSummary contract, SSE/WS, random-search training

- **Date:** 2026-09-07 17:05
- **Developer:** opencode (big-pickle)
- **Topic:** analytics

## Request

"make sure everything is live back to gateway sse style events with ws on gateway.
training should be done on tensorflow neural network with random search hyperparameter
tuning, all model training precision recall acc f1 confusion matrix all logged and pushed
to ws for ui rendering, best model tf selection export" + explicit `PcaSummary` /
`HistoryPoint` TS interfaces to honor. Also fix the empty `INGEST_SECRET` left by the
previous session.

## What was done

- **Fixed the `.env` blocker.** `INGEST_SECRET=` was empty because the earlier `printf`
  format had a `%s` with no argument. Regenerated via `openssl rand -hex 24`, `sed`-replaced
  line 27, recreated containers. Pusher → ingest went live (health showed windows
  incrementing every 60s; latestRisk reached "high").
- **PcaSummary / HistoryPoint contract.** `Analyzer.ingest` now emits the exact contract
  shape: `projection` (context PC score matrix), `components` (loadings), `variance`,
  `eigenvalues`, `totalVariance`, `mean`, `std`, `drift` (Hotelling T²), `driftClassification`
  + `risk`, `confidence` (1−χ²-tail p), `heartbeat`, `lastRun`; per-PC detail moved to
  `pcScores`. `/v1/analytics/risk` + `/pca` return this; `/v1/analytics/historic/windows`
  returns `HistoryPoint[]`.
- **Event bus + real SSE.** New `analytics/app/events.py` in-process bus. Analytics emits
  every live event; one subscription escalates each to `POST /api/analytics/scores`
  (gateway), and `/v1/analytics/stream` is now a real SSE stream (seed event replay +
  keepalive + live `analytics.*`/`training.*`). Gateway proxies it one-hop as
  `GET /api/analytics/stream`; `extractKey` now also accepts `?key=` so a browser
  `EventSource` works.
- **Gateway fan-out.** `POST /api/analytics/scores` now broadcasts any `analytics.*`,
  `training.*`, `pca`, `store.*` payload over the existing admin `/ws` (was risk/drift only).
- **Random-search TF training.** `training.py` rewritten: first build ≥ `MIN_ROWS`, then
  open-and-fine-tune (never wiped). Each run = `ANALYTICS_TRAIN_TRIALS` random trials
  (units 12/24/48, layers 1/2, dropout 0/0.1/0.3, lr 1e-3/3e-4/1e-2, batch 32/64/128,
  epochs 0.6–1× budget). Per trial: full split-validation precision/recall/accuracy/F1 +
  3×3 confusion (new `mathlib.confusion_matrix`/`classification_metrics`, pure python).
  Every trial logged to `training_runs` (`hp`/`metrics`/`confusion`/`best`, SQLite
  migration added) and streamed as `training.progress`; best by macro-F1 (fallback acc) is
  exported as `{name}.keras` + `.tflite` and announced via `training.done`.
- **UI.** Analytics card shows best-model metrics (F1/acc/P/R), live trial lines from WS
  `training.progress`, and the PcaSummary readout (PC z, explained-variance %, T²/drift,
  confidence).
- **Verification.** analytics pytest 14/14; gateway typecheck clean + 66/66 tests (new
  `analytics-pusher.test.ts` asserts the P=10 FEATURE_NAMES order); UI script `node --check`
  clean; live E2E: proxied risk + historic OK, SSE seed event streamed through the gateway,
  WS client received `analytics.ping` pushed analytics→gateway→`/ws`.
- **Envs/docs.** `.env.example`, README env table + analytics section, docs/analytics-layer.md
  (§7 API, §7.4 contract, §8/§9 training), PRD §11 env + §6.13 #58 all updated to the live
  state (new vars: `ANALYTICS_TRAIN_TRIALS`, `ANALYTICS_TRAIN_VALIDATION`,
  `ANALYTICS_TRAIN_SEED`, `ANALYTICS_GATEWAY_URL`; removed the `analytics-train` service).

## Notable findings

- `Response` (express) shadows the global fetch `Response` in control.ts — the SSE proxy
  needs `Awaited<ReturnType<typeof fetch>>`.
- Gateway-test image has node_modules but gateway-dev (prod) does not, and 127.0.0.1 inside
  a compose service ≠ host — WS smoke had to run from `gateway-test` against
  `gateway-dev:8080` with Node 22's native `WebSocket`.
- PcaSummary `components` semantically changed from per-PC score objects to the loadings
  matrix; UI + any consumers must read `pcScores.sub` for per-component z now.
- Pure-python Jacobi eigh + Lentz continued-fraction χ² tail hold up well numerically;
  variance banner in the sklearn-free PCA test needed biased (ddof=0) comparison.

## Open threads

- TFLite inference not yet wired into the live label path (`modelActive` surfaced only).
- `analytics.drift` event type unused so far; SSE has replay of latest only (no event log
  / history replay).
- Training-data JSONL/CSV export endpoint still deferred; `historic/windows` is the export
  surface for now.
- Gateway ingest backlog is in-memory (48 windows); Redis-escrow handoff deferred.
- Drift via PSI/KL/KS/MMD, loading-shift, lookalikes + sqlite-vec embeddings still pending.
- Laptop `~/.config/opencode/opencode.json` context fix remains pending (outside this repo).