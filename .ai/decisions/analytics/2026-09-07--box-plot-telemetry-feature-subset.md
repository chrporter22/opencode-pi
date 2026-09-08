# Box plots track live telemetry only (cpu · mem · temp · p95 tok/s)

Date: 2026-09-07

## Decision
The Feature z box plots (`#boxFeat`) in ML Analytics render only the live
telemetry features, in this order: `cpuFrac`, `memFrac`, `tempC`,
`log1p_p95TokPerSec`. Exactly one tokens-per-second feature is used and it is
the **p95** percentile (tail of the token rate), per explicit user choice.
Request-plane features (req/min, errorRate, p95/p99 latency, p99 tok/s) and
`diskFrac` no longer appear on the box plot.

## Why
- Box plots are the operator's window into the live system: cpu, mem, temp and
  throughput. The latency/error/req-rate features clutter the plot and are
  already visible in the scorecard + 3D explorer (PC loadings, raw windows).
- One tok/s feature keeps the plot at 4 boxes and unambiguous; p95 was chosen
  over p99 because p95 is the more representative "sustained" token rate while
  p99 is noise-sensitive.

## Behavior notes
- The subset is enforced client-side and intersects with the feature filter:
  if any of the 4 is masked out by `feature_filter`, it simply doesn't show
  (never forced on).
- This is a display choice; the 10-dim input vector to the model, PCA, and
  training are unchanged.