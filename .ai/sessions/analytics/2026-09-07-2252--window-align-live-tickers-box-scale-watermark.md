# Session 2026-09-07–22:52 — window alignment, live tickers, box-plot scale cap, watermark surfacing

## Topic: analytics gateways UI (gateway + analytics microservice)

## What was done

### Box plots — scale fix (gateway/public/index.html, `renderBoxes`)
- Problem (user-confirmed): one feature with a huge |z| (e.g. temp has tiny raw σ) blew out the
  shared y-axis → everything else squished onto the centerline.
- Fix: cap the z-axis at `±8σ` (`Z = Math.min(Math.max(3, …flat)+0.8, 8)`) instead of
  `Math.max(3, …flat)+0.8`. Outliers beyond ±Z are drawn as risk-colored ▲ triangles pinned at
  the plot edge (red ≥ highσ, amber otherwise) instead of stretching the scale. Label now reads
  "scale capped ±8σ … ▲ = clipped extreme".

### Windows anchored to the wall clock (gateway/src/modules/analytics/pusher.ts)
- `windowPayload()` now uses `from = Math.floor(now / (windowSec*1000)) * (windowSec*1000)` —
  windows are created on the :00/:60 wall-clock marks (previously anchored to process start,
  rolling). `lastTick` gone.
- Replaced the rolling `setInterval` with a self-rescheduling `setTimeout` that fires `delay =
  tile - (now % tile) + 25ms` after each tick → exactly at each tile boundary. 5s prime tick kept.

### Richer live telemetry on the wire (gateway/src/metrics.ts + ws.ts)
- `SystemSnapshot` now carries `sampleMs` (wall time of the snapshot read). `snapshot()` measures it.
- `system.metrics` WS event now also broadcasts `diskUsedPct` + `sampleMs` (kept `disk` object off
  the wire to avoid clobbering the aggregate object in the UI).

### Live tickers (gateway/public/index.html)
- ML `ml-short` "Live" card gained two rows:
  - **window clock** (`#mlWinClock`): 1s ticker showing `:SS · next :00 in MM:SS`, and at the
    boundary refresh triggers `mlReload(true)` (once per tile, via `lastWinBoundary`).
  - **tele ticker** (`#mlTeleTicker`): rendered in `renderSystem` as `[cpu% · mem% · disk%] ·
    N.Nms` from the last `system.metrics` sample (uses new `diskUsedPct`/`sampleMs`).
- `renderSystem` now favours `s.diskUsedPct` (live) over the stale aggregate disk object.

### Watermark "working from last training data" — verified
- Logic was already correct, confirmed by reading `training.py` + `runtime.py` + `warehouse.py`:
  - `set_watermark(watermark)` persists into the durable config-doc `watermark` (survives restart).
  - `watermark = training_max_window_start()` = MAX(window_start) of labeled windows at train end.
  - Fine-tune pulls `window_start > watermark` (`training_features(since=…)`), gate via
    `new_training_rows(watermark) > 0` → no re-training of identical history.
- **Surfacing in the UI**:
  - Training card (`ml-train`) gained rows `watermark · trained up to` (`#mlTrainWm`) and
    `model metadata` (`#mlTrainMeta`) fed from `train.trainedUpTo` / `train.modelMetadata`.
  - Models table (`ml-models`) gained `watermark` + `metadata` columns (kind, dim, params, F1,
    datasetRows, fineTuned, trainSeconds) via new `modelMetaBrief()` helper.
  - `saveCfg()` now also calls `mlReload(false)` so config save + `training.done` event refresh the
    whole ML page incl. watermark/metadata; docs endpoints table mentions metadata incl. watermark.

## Significant bug caught during this session
- A pasted edit of `modelMetaBrief()` was missing its closing `}` → the entire inline `<script>`
  failed to parse, which is what the user saw as "ui is all messed up with size" (no JS ran: cards
  unpopulated, canvases 0-height). Fixed the brace; `node --check` clean; also verified only 1
  script block extracts and all member functions present.

## Files changed
- `gateway/public/index.html` — box-plot cap/▲, Live-card tickers, window-clock interval,
  renderSystem diskUsedPct/sampleMs, train-card watermark/metadata rows, models table columns,
  `modelMetaBrief()`, saveCfg `mlReload(false)`, docs table text.
- `gateway/src/modules/analytics/pusher.ts` — tile-anchored windows + boundary scheduler.
- `gateway/src/metrics.ts` — `sampleMs` in snapshot.
- `gateway/src/ws.ts` — `diskUsedPct` + `sampleMs` on `system.metrics` (import `SystemSnapshot`).

## Verification
- `node --check` on extracted inline script: OK; no duplicate ids; every `q()` ref resolves; new ids
  present; `lastTick` fully removed.
- Gateway: `tsc --noEmit` clean (installed deps in `/tmp/opencode/gw` copy); `vitest run` 66 passed
  / 11 files, incl. analytics-pusher window tests.

## Open threads / notes
- The TF-model capacity answer (per user): ~0.2ms/call → can serve 2×/sec easily; we intentionally
  keep NN scoring per 60s window (sub-second windows make RPM/percentile features degenerate).
  Only the live tele ticker/clock were added, per user choice.
- Analytics backend untouched this session → no pytest rerun needed.