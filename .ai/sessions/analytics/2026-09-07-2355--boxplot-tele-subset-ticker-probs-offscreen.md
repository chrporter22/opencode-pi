# Box-plot tele subset (cpu·mem·temp·tok/s) · live nn probs in ticker · off-screen page fixes

Date: 2026-09-07 · follow-up round after 2330 (live NN per-sample batch)

## User requests clarified
1. Box plots: include ONLY cpu, mem, temp, and tokens-per-second. Cleared with
   user: the tok/s feature = **p95 tok/s only** (4 boxes). "Box plots" = the
   `#boxFeat` Feature z chart in ML Analytics.
2. Tele ticker: the nn label must change with the 3 probability findings and
   show live prob percentages; report that only the first percentage in the
   `[ ]` updated live — the other two were effectively static/absent.
3. Off-screen pages: warehouse, storage, logs, metrics, documents, ml-analytics,
   playground — cards/modules spilled past the viewport right edge. Approved
   approach: wrap wide tables in `.table-scroll`, `.filter-bar` flex-wrap, and
   card-level overflow containment.

## What was implemented

### Tele ticker (root cause of "only first % updates")
- `nnTxt()` only emitted the runner-up class when its prob ≥ 10%, so the watch/
  high percentages were often hidden and looked frozen/absent.
- `updateTeleTicker()` now renders **all three** live probabilities from the
  freshest `liveNn` event: `· nn normal 92% · watch 7% · high 1%` (label =
  argmax class, changes as inference flips). Every `analytics.infer` /
  `analytics.risk` / `syncInfer` update rewrites all three, so all change live.
  Chips (`anNnChip`/`mlNnChip`) keep the compact `label top% · runner-up%` form.

### Box plots → cpu · mem · temp · p95 tok/s
- `renderBoxes()` builds the plot from `BOX_FEATURES =
  ["cpuFrac","memFrac","tempC","log1p_p95TokPerSec"]` filtered against each
  row's `featureNames` (only features active in the filter appear — if cpu,
  mem, temp or tok/s is masked out it won't show). Per-row values are resolved
  with an index map (`idxOf`) instead of positional slicing, so archive rows
  whose dims shifted over config changes still map correctly.
- Labels via `BOX_LABELS` map (cpu / mem / temp / tok/s), falling back to
  `shortLabel`. New empty states for "no cloud rows" and "all 4 features
  disabled". `mlBoxLabel` text updated to the live-feature subset.
- `FEAT10` constant added (full 10-feature fallback ordering).

### Off-screen page fixes
- Documents page: both big `table.doc` blocks (Endpoints, Environment
  variables) wrapped in `<div class="table-scroll">` — their fixed-width mono
  cells previously overflowed the viewport.
- `.card { overflow-x: auto }` — containment net so stray wide content gets a
  card-local scrollbar instead of blowing the page width (page-level overflow
  is gone; nothing is hidden).
- `.filter-bar { flex-wrap: wrap }` (SQL console buttons, log filters).
- `.table-scroll { max-width: 100% }`.
- (Earlier in this session's work: `.dashboard` grid `minmax(0,1fr)`,
  `.ml-split` `minmax(0,1fr)`, `.neo-ascii` internal scroll, `body`
  `overflow-x:hidden`, `.view`/`.content`/`.card` width guards.)

## Verification
- UI JS extraction → `/tmp/opencode/ui-extract.js` `node --check` OK.
- id duplicates: none; `q()` refs missing: none (only dynamic btnThemeBar /
  sbClock, null-guarded).
- Documents section div balance 7/7 (2 new `.table-scroll` wrappers), tables
  2/2.
- No gateway TS changes this round (HTML/CSS only) — prior `tsc --noEmit` +
  66 vitest remain the last green baseline.

## Notes
- Box plots and ticker are pure client-side; no backend change needed.
- Deferred by design: chips stay compact (top + notable second) — user asked
  for the full triplet specifically in the tele ticker.