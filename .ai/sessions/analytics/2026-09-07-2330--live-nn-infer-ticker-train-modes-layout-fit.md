# Live NN inference per tele sample · train modes · layout fit

Date: 2026-09-07 · batch after 2252 (window-align + tickers + box-scale + watermark)

## What the user asked
1. Tele ticker + TF-Lite chip should show prob + label class from live NN
   inference on each incoming tele sample (not the static 60s reference window).
   This **supersedes** the earlier "Answer only, keep 60s windows" choice.
2. Fix UI pages so everything fits when cycling views.
3. Add an option to train the model from the last watermark.

## What was implemented

### Analytics backend
- `service.py` `Analyzer.live_score(features)` (after `infer_now`): read-only
  classify — no EWMA update, no reference/window writes. Accepts either the full
  10-dim vector (masks via feature_filter) or the already-filtered dim. Emits
  `analytics.infer` event with `source="live"` and returns the result.
- `main.py` `POST /v1/analytics/infer/current` (bearer auth, body `{features}`),
  404 "no model or invalid live feature vector" when `live_score` returns None.
- `training.py`: `start(analyzer, mode)` / `_run(analyzer, mode)` /
  `_train(analyzer, mode)` with modes `auto` (today's behavior: fine-tune from
  watermark if a savedmodel exists), `watermark` (force incremental from
  watermark), `full` (rebuild fresh from every labeled window, no fine-tune).
  `training.started` now carries `mode` and `since`. Default stays `auto`, so
  existing callers/tests are unchanged.
- `main.py` `/v1/analytics/training/start` accepts optional body `{mode}`.

### Gateway
- `pusher.ts`: extracted `collectRecords` / `composeFeatures` / `awaitMetrics`
  to module scope (shared by window pusher and new live scorer). Added
  `createAnalyticsLiveScorer` → `POST /v1/analytics/infer/current` on every
  `metrics.subscribeSample` tick (~5s), in-flight guard, fire-and-forget,
  warn only on non-404 failures (404 = no model yet, silent).
- `index.ts`: instantiate/start/stop the live scorer beside the pusher when
  analytics is configured.
- `control.ts`: `/api/analytics/training/start` now passes `req.body` through.

### UI (index.html)
- `liveNn` state (label/prob/ms) updated by `analytics.infer` and
  `analytics.risk` WS events; `nnTxt()` renders `label <top>% · <second>%` when
  a pc ≥ 10% beats the runner-up; `setNnChips()` updates both `anNnChip` and
  `mlNnChip` with `tf-lite <label>% · ms`; `updateTeleTicker()` appends
  `· nn <label>%` to the `mlTeleTicker` sys line (called from `renderSystem`).
- `syncInfer` and `renderAnalytics`/`renderMlPage` chips now prefer `liveNn`.
- New buttons in `ml-train`: **Train from watermark** (`train("watermark")`) and
  **Full rebuild** (`train("full")`); `train(mode, btn)` posts `{mode}`.
- Layout-fit: `body { overflow-x: hidden }`, `.content`/`.view` `max-width/min-width`
  guards, `.dashboard` grid columns `minmax(0, 1fr)` (the `1fr` tracks were
  `minmax(auto,1fr)` → wide content forced horizontal overflow when cycling),
  `.ml-split` `minmax(0,1fr) minmax(0,1fr)`, `.card { max-width: 100% }`,
  `.neo-ascii` `max-width:100% + overflow-x:auto` (pre art no longer blows the
  page width). `showView` already resets scroll to top.
- Docs table: `/api/analytics/infer/current` row.

## Verification (all green)
- `/tmp/opencode/ui-extract.js` `node --check` OK; id dups: none; q() refs:
  only dynamic `btnThemeBar`/`sbClock` (null-guarded), no missing.
- Gateway (via `/tmp/opencode/gw` copy): `tsc --noEmit` clean, vitest 11 files
  / 66 tests passed.
- Analytics: `docker compose run --rm analytics-test` → 46 passed, 2 skipped;
  with `ANALYTICS_ML_E2E=1` → 48 passed (real TF train + fine-tune + classify
  roundtrip, exercising the changed `_train` default path).

## Open notes
- Live inference uses the same request lookback + sys snapshot as window
  composition; per-call ~0.2ms TF-Lite so cadence is not a concern.
- Attention rec: `createAnalyticsLiveScorer` reuses the pusher deps type
  (`AnalyticsPusherDeps`) — deliberate to avoid a second parallel type.