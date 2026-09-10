# 2026-09-09 14:20 — label mode switch + ML UI polish batch + gateway relabel body fix

## Goal
Close the ML/UI round: PCA z-score relabel option with labelMode toggling, NN→log-reg
rename throughout the UI, live ticker cluster, T² mini-spark, feature pills, keys
modal, ML layout restructure, BoxPlots T² + glass, Overview request-stream fix;
then verify everything (tests + sweep) and update docs/memory.

## Done
### Backend (analytics)
- `runtime.py`: `labelMode` (`p_value` default) added to `_DEFAULT_DOC`; effective
  accessor + config GET/PUT round-trip.
- `main.py` relabel endpoint reworked to dict payload (`payload: dict | None`), no
  pydantic: persists `labelMode/labelPWatch/labelPHigh/watchZ/highZ` via
  `runtime.save(patch)`, calls `store.relabel_windows(p_watch, p_high, mode, z_watch,
  z_high)`, `analyzer._check_reset()`, optional `trainer.start(mode="full")`, emits
  `analytics.relabel`. Config GET returns labelMode (effective from runtime doc).
- `warehouse.relabel_windows` gains `mode`/`z_watch`/`z_high`; z-score path uses
  `mathlib.risk_label(pcz, watch_z, high_z)`; returns counts + mode + thresholds.
- `service.py` live ingest labels per active `label_mode` (t2/p still computed).
- Tests: `analytics/tests/test_relabel_backtest.py` — `test_relabel_windows_z_score_mode`,
  `test_risk_label_thresholds`, `test_label_mode_z_score_drives_live_risk`.
  **56 passed, 2 skipped.**

### Gateway
- `routes/control.ts`: `POST /analytics/relabel` proxy now forwards `req.body`.
  **Bug:** it previously declared `_req` and passed NO body, so every relabel ran as
  p_value regardless of the UI's chosen mode. Verified fixed end-to-end (z_score
  applied + persisted, then restored to p_value).
- **68 gateway tests, 1 fail (pre-existing, environmental):** `GET /api/model …
  installed=false when missing` — asserts `installed:false` but a model file exists
  in the container, so it returns `installed:true`. Unrelated to this change.

### UI (built in ui-dev, dist swapped into gateway/public)
- Rename pass: NNCard→`LogRegCard.tsx` (new file, NNCard deleted), NNScorecard→
  LogRegScorecard, "log-reg" wording in buttons/labels/ws notes/statusbars/sparks/
  table headers/Documents docs. Keys/`data-nn-prob` attributes kept for sweep.
- Sidebar collapsible (52px/220px, `piSidebar` LS key, `initials()` nav labels).
- PCA canvas 250px with "last 300 windows (limit=300)" note.
- Total variance PC1–4 row in LogRegScorecard.
- StatusBar ML ticker cluster (elapsed h:mm:ss.t, ctx count/cap, fill est), gated
  `ui.view === "ml"`.
- LiveCard T² mini-spark (Spark h=18); ML view poll 5s incl. `loadBacktest()`.
- ConfigCard feat filter → feature pill toggle grid; Save config in actions row.
- Sidebar API-key inline inputs → "api keys · set" themed modal (`applyKeys()`; only
  header key `x-api-key`, no emoji).
- ML layout: LogRegScorecard full-width; left col (LiveCard + DriftChart +
  TelemetrySparks), right col BoxPlots; LiveCard `self-start`.
- BoxPlots add `__t2__` (box of T² across cloud pts, amber median) + `glass` class;
  `.card.glass` CSS in index.css (translucent gradient, blur, border, shadow).
- `load.ts` `refresh()` also calls `loadRequests()` → Overview streams populate via
  REST even when WS is down (user: "client request streams are down too on overview").
- `types.ts` `ModelMetadata.metrics` widened to accuracy/precision/recall (fixes
  TS2339 in deployedModelLine).

## Verification
- analytics pytest: 56 passed / 2 skipped.
- ui-dev: `tsc --noEmit` clean, `vite build` ok, `vitest run` 8 passed.
  Dist swapped: `index-BwxsUP9K.js` + `index-BSsdoawG.css`.
- gateway-dev: typecheck clean; 68 tests (1 pre-existing env fail); runtime relabel
  via gateway now honors mode.
- Playwright sweep (`/tmp/opencode/ui-sweep-spa.mjs`, pi-sweep, planner): all views
  render, wsOk+wireOk true, 0 console errors, no overflow; `mlCheckOk` true
  (probCards 3, deployedRows 2, varianceRow, watermark-as-time, pcaNote+250px,
  ticker/elapsed/ctx/fill, sidebar 52↔220). Sweep selector broadened to `.row .k`
  (scorecard rows are divs, not table rows) and ctx regex relax.

## Open / follow-ups
- BacktestCard does not yet show a "tested model" row for the "training and
  backtesting should be one model" ask (addressed via deployed-model rows only).
- No git commit (standing instruction).
- Docs updated: analytics/README.md (relabel body + labelMode), docs/analytics-layer.md
  §12.1 (labelMode), decision file round 3.