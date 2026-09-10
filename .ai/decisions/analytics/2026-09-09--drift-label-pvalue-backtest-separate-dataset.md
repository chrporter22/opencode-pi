# 2026-09-09 — drift labels from Hotelling T² p-value; backtesting as a separate dataset

## Why
The stored drift labels were assigned from PCA z-score thresholds (`watchZ`/`highZ`).
In practice those labels produced a degenerate training set (954 high / 184 watch /
151 normal) and a model that always predicted "high" (f1 0.33 on 5 rows). The user
chose to fix labeling at the source instead of re-weighting classes.

## Decision
- **Labels = Hotelling T² p-value tiers.** Recomputed for every window from its
  stored PCs (`t2=Σ pcz²`, `p=chi2_sf(6,t2)`), then upserted back into `windows`
  (`risk`, `t2`, `p_value`). Tier boundary: `p ≥ 0.10` → **normal**, `0.05 ≤ p < 0.10`
  → **watch**, `p < 0.05` → **high**, `None` → **normal**. Boundaries are runtime
  config (`labelPWatch`/`labelPHigh`), not compile-time. `watchZ`/`highZ` and the
  stored z-scores / loadings / eigen are KEPT purely for the PCA cloud & drift
  bars display — they no longer define labels.
- **Relabeling is a first-class admin action** (`POST /api/analytics/relabel`):
  full dataset, idempotent, returns the new class distribution.
- **Backtesting writes to a SEPARATE SQLite dataset** (`backtest_runs` +
  `backtest_samples`). It never mutates the live `windows.nn_risk/nn_prob`, so
  backtest runs are reproducible and the production dataset stays clean.
  Each sample carries the active `modelWatermark` at prediction time.
- **"Train & backtest" semantics = true hold-out**: read the pre-run watermark,
  run a FULL retrain, then backtest only windows strictly after that watermark
  (data the prior model had never seen). "Backtest (current)" scores all stored
  vectors with the current model.
- **Watermark can be cleared** (`POST /api/analytics/watermark/clear`) to force the
  next training to be a full retrain (`trainedUpTo` reset on both runtime and
  trainer state).
- **Resilience rule (from this incident):** a persistence-`running` training state
  surviving a process restart is treated as stale and reset at startup
  (`TrainingOrchestrator.clear_stuck()`). Artifacts shorter than 1 byte are treated
  as "no model", and tflite is exported atomically (tmp + rename).
- **UI rule:** API failures must be surfaced inline in every ML action (no silent
  `catch {}`); the ML page is organized into labeled sections with runtime +
  filters pinned to the bottom.

## Status
Shipped (UI swapped + swept clean, backend 52 tests green, live repair exercised
the whole path: relabel → full retrain → infer 200 → backtest current + train).
No commit yet (user's standing instruction).

Round 2 (shipped): probability-`softProb` (floor 0.10 + renormalize), bar widths
only — argmax/label and the model's probabilities untouched — so live near-one-hot
TF outputs still animate all three class bars. The scorecard shows the **pipeline
label** (incoming window's PCA/EWMA T² p-tier, already stored in SQLite) next to the
**tf-lite class** as distinct chips, and **context window counts**
(`risk.contextWindows/contextCap`, `meta.context {count,cap}`) are first-class
pipeline metrics on the scorecard/Live card/Metrics spark/doc flow.

Round 3 (shipped): **label source is a runtime switch — `labelMode`**
(`p_value` | `z_score`, persisted in runtime config, default `p_value`). The relabel
endpoint accepts `{mode, pWatch, pHigh, watchZ, highZ, retrain}` as a plain dict
(no pydantic), persists the mode, recomputes the whole dataset, optionally
full-retrains, and emits `analytics.relabel`. Live ingest assigns the label per the
active mode (t2/p still computed in parallel). Also shipped this round: UI rename
NN/neural→**log-reg (TF-Lite)** everywhere, live ML ticker (elapsed/ctx/fill),
T² mini-spark + small metadata values in LiveCard, feature pills on the Config card,
dev-key popup modal (replacing inline sidebar inputs), ML layout restructure
(scorecard full-width; live+drift+telemetry left, box plots right), BoxPlots T² +
frosted-glass cards, Overview streams repopulate on refresh via `loadRequests()`.
Sidebar is collapsible (52px/220px, persisted). Verified: backend 56 tests, gateway
68 tests (1 pre-existing env-dependent `/api/model` failure), sweep fully green.
**Bug found & fixed meanwhile:** the gateway proxy for `/api/analytics/relabel`
dropped `req.body` (declared `_req`), so every relabel ran as p_value regardless of
the UI's chosen mode — fixed to forward the body exactly like `training/start` does.