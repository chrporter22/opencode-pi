# UI polish round: branding, layouts, PCA styling, ML telemetry, logs filters + model swap verification

- **Date:** 2026-09-07 21:34
- **Decided by:** user (approved the consolidated plan at ~21:45)
- **Topic:** analytics

## Decisions

1. **Data ops (immediate, approved):**
   - Copy the old `analytics-state` volume DB (19 scored windows) over the fresh `/opt/qwen-ml/analytics.db` — done, verified live.
   - Backfill `z` for the imported rows (recomputed from the stored EWMA reference) so box-plots, 3D halos and tooltips work on the history.
   - Delete the stale `risk.net.keras` artifact (pre-tf_keras-fix format, fails deserialization under the current runtime) — regenerable by retraining. User approved this hard-delete explicitly.
2. **No image rebuild for the model swap.** The model is host-mounted (`/opt/qwen-model:/models`) and the swap is verified live: `Qwen2.5-Coder-3B-Instruct Q4_K_M`, ctx 32768, loaded.
3. **UI (approved as planned):**
   - Branding: title + topbar subtitle carry the live Qwen model name/quant/ctx.
   - Connections grid rebalanced (Host full, Warehouse·SQLite full, Redis + ML artifact store 1×1); tighter compact mode; TF training + warehouse-first scorecards span full width; storage gains raw counts/artifacts/persistence list.
   - Logs get source filters (All/ML/Requests/System); Metrics gains an ML telemetry sparkline card.
   - ML Analytics page: drift + feature cards in a full-width 50/50 split; training/inference card full width; PCA dots re-colored viridis-by-value with light gridlines and a scale/key.
   - **context windows belongs to the Qwen model** (32768), not ML inference: remove the `cfgCtx` control from the ML config (ML analysis context stays at the env default 12); surface Qwen ctx in the Model card + subtitle.

## Why

- The imported history predates the `z` column, so without a backfill the ML visualizations show misleading/empty data.
- The stale `.keras` was written by the pre-fix runtime; it cannot be loaded by the current one, so it only produces a permanent error status.
- Qwen context windows (what the user colloquially calls "context windows") is a llama-side setting, distinct from the ML analysis window count — keep the two clearly separated.

## Supersedes / relates to

- `.ai/decisions/analytics/2026-09-07--analytics-rename-persistence-writeback-scope.md`
- `.ai/decisions/model-runtime/2026-09-07--model-swap-qwen25-coder-3b.md`