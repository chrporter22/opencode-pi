# Docs expansion + pipelines streaming + dashboard logs + box/compact/PCA fixes + README config

- **Date:** 2026-09-07 22:00 → 22:25 (finalized)
- **Developer:** opencode (big-pickle)
- **Topic:** analytics (UI + docs) + control-center config

## Request (paraphrase)

Initial: write the pasted opencode config (opencode-pi LAN + Google Gemini) into the README; docs page for model HTTP methods, Hotelling T² + PCA pipeline, what the TF-risk model predicts and how it gives insight, training pipeline + dataset modeling, what "requests" is; investigate training errors; stream into each pipeline card; make the dashboard logs card work; analytics telemetry in one row; box-plot axes readable; is the risk label made from the p-value?

User answers that refined scope:
- opencode config: *"I will write the config — just show me what to paste; update the README sample config without the dev key and without the Pi address."* → README sample uses placeholders only; corrected config (model id fix) shown in chat for the user to paste.
- Docs location: extend `docs/analytics-layer.md` **and** add a UI section with analytics docs + visual flow chart.
- Compact mode buttons get squished/overlapped → review/fix.
- PCA tooltip: show sample size (N rendered windows) + format data cleaner.
- PCA plot should be more square than rectangle.
- Box plots "not rendering correctly" → fix.
- Streams needed in pipelines (confirmed).

## What was done

### README config (README.md §5)
- Replaced the sample opencode config with a **sanitized** block: placeholder `<pi-ip>`/`<INFERENCE_API_KEY>`, `{env:GEMINI_API_KEY}`, both providers, `"model": "google/gemini-3.6-flash"`, correct model id `Qwen2.5-Coder-3B-Instruct` (must match `GET /v1/models`).
- Gave the user a copy-paste block with their real values in chat (192.168.1.177 + dev-inference-key, id fixed from `Qwen2.5-Coder-3B` → `Qwen2.5-Coder-3B-Instruct`, output 32768).

### Docs (docs/analytics-layer.md)
- **§3 "What requests means"** (new): per-request 6-feature vector from `pusher.ts` — log1p(prompt/completion/totalTokens), log1p(tokensPerSecond), log1p(durationMs), error(0/1). Corrected the wrong claim that the TFLite model consumes `context`; it consumes the single-window `features`.
- **§5 Risk model rewritten** (was factually wrong): labels come from **top-3 PC z-scores** vs watch/high σ thresholds (`risk_label`), NOT the p-value. Hotelling T² = Σ pcz² with χ² tail p is informational only (`confidence = 1 − p`). Documented the raw-masked-vector NN classification and "drift from adaptive EWMA norm" meaning.
- **§7.0 Model serving — HTTP methods** (new): `/v1/models`, `/v1/chat/completions`, `/health`, `/api/status`, `/api/model`, `/api/model/update`, `/api/model/restart`, `/api/system*`, `/api/metrics`, `/api/logs`, `/api/requests`, `/api/analytics/infer`; model-id aliasing note.
- **§8 Training data & dataset modeling** (rewritten): auto-labels, `X = feature_vec` (raw masked) / `y = normal|watch|high`, incremental learning + watermark, `<5` rows → `training.skipped`, random-search MLR/MLP trials + pure-python metrics, `training.progress/done/error` events.
- **§9 Model artifacts** (rewritten): `/opt/qwen-ml`, SavedModel + `risk.tflite`, lifecycle (first build ≥ minRows or manual, fine-tune on new rows, `train:state` recovery note incl. deleting the stale Keras artifact), live TFLite classifier, model registry upsert.
- **§12 UI surface** (rewritten) to match current UI (docs/flow panel, square PCA with N tooltip, readable box plots, pipeline streams, working Live activity, one-row ML sparks, read-only ctx).

### UI (gateway/public/index.html)
- **ML page docs & flow card** (`ml-docs`): visual pipeline flowchart (telemetry → window → EWMA ref → PCA+T² → top-3-PC label → risk SSE → UI; warehouse → dataset → random-search train → fine-tune → risk.tflite feed-back as nnRisk, not into labels) + links to Documents view.
- **Box plots fixed + readable axes** (`renderBoxes` rewrite): rotated −45° x labels (no overlap), integer-σ y gridlines with numeric y labels, watch/high dashed σ lines, canvas 150→220px, label shows sample count.
- **PCA more square**: `.pca-stage` centered wrapper (max-width 560px, 430px compact) + canvas `aspect-ratio: 1/1`; removed fixed heights.
- **PCA tooltip sample size + cleaner data**: header `n = <cloud size> scored windows · PC axes view`; p shown as exponential (2dp); T² 2dp.
- **Per-pipeline streams**: `.mini` log boxes on each pipeline card (`pstream-inf/-up/-wh/-ml`) fed by `routePipes` (realtime WS) + `routeLogLine` (keyword-matched log lines + history backfill).
- **Dashboard Live activity now works**: history backfilled from `/api/logs` into `dashStream`, Clear button (`btnClearStream`), streams analytics.*/training.*/model status events via `streamNote` friendly lines.
- **ML telemetry one row**: `#ml-spark .spark-grid → repeat(5, minmax(0,1fr))` (stacks <860px).
- **Compact mode button fixes**: nowrap buttons, `.row.actions` wrap+margin, filter-bar wrap, topbar inputs narrower + wrap, mini-sync flex-fixed, h2 overflow visible.

## Verification
- Inline JS extracted → `node --check` clean (twice).
- No duplicate ids; every `q("…")` resolves (pre-existing dynamic `btnThemeBar`/`sbClock` exempt).
- Analytics: `docker compose run --rm analytics-test` → 46 passed, 2 skipped.
- Gateway copy in `/tmp/opencode/gw` (cp -r, no rsync on Pi): `npx tsc --noEmit` clean; vitest 66 tests / 11 files pass.

## Key files
- `README.md` (§5), `docs/analytics-layer.md` (§3/§5/§7.0/§8/§9/§12).
- `gateway/public/index.html` (CSS blocks ~296–435, compact block, `.pca-stage`/`.mini`/`.pipe-*`, `renderBoxes`, `render3d` tooltip, `appendStream`+`streamNote`+`pushMini`+`routeLogLine`+`routePipes`, WS handler, `loadLogHistory`, dash Clear button, pipeline card divs, ml-docs card).
- No backend/app code changed this session beyond earlier batch (risk.net.keras deleted, z backfill, train:state cleared).

## Open threads
- Pipeline streams + dashStream live only while the admin key WS is connected (expected).
- Compact box canvas stays 220px (inline style beats compact CSS) — acceptable, noted.
- A fresh `risk.tflite`/SavedModel will be produced on next real training run (minRows 4000; currently idle, rows still below that, ingest continuing).