# Live NN inference per tele sample (supersedes "60s window only" answer)

Date: 2026-09-07

## Decision
The tele ticker and TF-Lite chips show the probability + label class from a
live NN inference on **each incoming tele sample (~5s cadence)**, sourced from
the gateway via `POST /v1/analytics/infer/current`, which is strictly read-only
(classify only, no EWMA/reference/window writes). This supersedes the earlier
"Answer only, keep 60s windows" choice for the ticker, which was a cost
question — the measured ~0.2ms per TF-Lite call makes per-sample inference free.

## Why
- The training reference only refreshes every 60s tile; a per-sample read gives
  the operator current risk (label + probs) without waiting for the tile edge.
- Zero side effects: the classifier is stateless (`nn.classify`), so scoring a
  live vector cannot corrupt the reference/EWMA that drives PCA + the box plots.

## Implications
- `/v1/analytics/infer/current` returns 404 when no model or vector size is
  invalid; the gateway treats 404 as "no model yet" and stays silent.
- Live scores appear on the WS stream as `analytics.infer` with `source="live"`
  (UI drives both chips + the tele ticker `· nn label%` suffix from them).
- Manual "Run TF inference" (`/v1/analytics/infer`) unchanged: latest stored
  window, `source` absent (legacy shape kept).