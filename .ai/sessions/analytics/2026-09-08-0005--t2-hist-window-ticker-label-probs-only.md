# T² histogram last 20 windows · tele ticker only label + 3 probs

Date: 2026-09-07 · small follow-up in the same session as 2355

## User requests + approved answers
- T² history chart: cap to the most recent **20** windows (approved).
- Tele ticker: "first tele metrics only changes live — should the label and prob
  show only?" Approved: drop the quasi-static `[cpu · mem · disk] · ms` prefix
  and show ONLY the live nn label + all 3 prob percentages. (mem%/disk% are
  near-constant so they never appear live — that's why only cpu seemed to move.)

## Implemented
- `renderTs`: `mlHist.slice(-120)` → `mlHist.slice(-20)`.
- `updateTeleTicker()` is now the sole writer of `#mlTeleTicker`: renders
  `nn <label> normal % · watch % · high %` from the freshest `liveNn`; `nn —`
  when `!liveNn?.label`. The `[cpu·mem·disk] · ms` construction was removed
  from `renderSystem()` (which still calls `updateTeleTicker()` each sample —
  idempotent).

## Verified
- UI extract `/tmp/opencode/ui-extract.js` `node --check` OK; `slice(-20)`
  present; no duplicate ids.