# Space theme, smaller square PCA, live-append cloud, pipeline stream parity, compact metadata text

- **Date:** 2026-09-07 22:27 (finalized)
- **Developer:** opencode (big-pickle)
- **Topic:** analytics (UI)

## Request (paraphrase)

1. Metadata text needs work in compact mode too (after the button fixes).
2. Make the PCA plot a smaller square — it's too big.
3. Background colour: more modern, "space-like".
4. Append new PCA data to the 3D PCA plot so it updates live (instead of waiting for the periodic full reload).
5. Update the streams on the Pipelines page to look like the stream format on the dashboard (Live activity card).

## What was done (gateway/public/index.html only)

- **Space-like background:** body now layers three fixed nebula-style radial gradients (accent/model/wh accent washes, 7–13%, fading to transparent) over `--bg` with `background-attachment: fixed`. Works in every theme (dark/viridis/whale/rose-pine) since it uses CSS `color-mix` with the theme variables.
- **PCA smaller square:** `.pca-stage` max-width 560 → 440px (still centered, aspect-ratio 1:1); compact-mode override 430 → 340px.
- **Live PCA cloud updates:** added `mergeCloud(prev, next, cap)` (incremental diff-append by `windowStart`; detects server resets/rebaselines via newer-older *last* windowStart or a >5-row shrink and replaces instead) and `pingCloud()` (lightweight cloud-only fetch). `loadMlPage` now merges instead of replacing `mlCloud`, and `mlReload(true)` (fires on every `analytics.risk` WS event) calls `renderMlPage()` + `pingCloud()` immediately — a new scored window appears in the 3D plot + box plots right away, then the existing 4s debounced full `loadMlPage` still refreshes hist/latency/runs/models. Fixed `renderBoxes`/`render3d` render off the same merged cloud so sample-size tooltip stays accurate.
- **Pipeline stream format parity:** `.mini` stream boxes on the Pipelines page now carry the same row styling as the dashboard Live-log: time (`.t` faint), colored tag (`.tag err/ok/warn/info/sys/ml/dim`), bright message (`.msg`), flash on new events. Previously only `.log .*` selectors were styled, so pipeline mini-streams rendered plain.
- **Compact metadata text:**
  - `.row > span:last-child` wraps + break-words (long value strings no longer overflow/overlap the key column).
  - Long text fields downsized to 10.5px in compact: `#anIn`, `#anPca`, `#anSys`, `#anNn`, `#mlTsLabel`, `#mlBoxLabel`, `#anTrials`, `.pca-legend`, `.pipe-note`, `#mlTooltip`.
  - `.pca-legend` wraps; `.pca-scale` shortens to 90px.
  - `.chip` truncated with ellipsis (max 150px, nowrap) so long level/model chips don't squeeze sibling content.
  - cfg/dox-note/summary labels down to 11px (10.5px doc-note).

## Verification
- Inline JS re-extracted → `node --check` clean; duplicate ids none; every `q("…")` resolves.
- No backend/app changes; analytics tests unaffected (46 passed / 2 skipped on the prior run; no app code touched this round).

## Key files
- `gateway/public/index.html` — body background (~48–58), `.mini` row styles (~after `.log .msg`), `.pca-stage` + compact PCA, compact metadata rules (~400), `mergeCloud`/`pingCloud` + `loadMlPage` merge + `mlReload` skip-ping (~1560–1615, ~1980).

## Open threads
- `pingCloud` fires on every `analytics.risk`; payloads are small (≤300 rows) so this is fine at the ~30s+ ingest cadence.
- Dashboard/metrics/other views still use the standard 5s `refresh()`; only the ML page has live cloud ping.
- Decision recorded in `2026-09-07--readme-config-sanitization-docs-location.md` still stands (this round is pure UI, no new organizational decision).

## Follow-up round 22:30 — warehouse card span + box-plot active-features

- Warehouse page: `wh-conn` (Warehouse connections) `span2` → `full` so it spans the whole page.
- Box plots: user chose "show only the active features". `featureNames`/`z` from `pca/cloud` are already masked to enabled features; `renderBoxes` now (a) strictly slices row `z`/`features` arrays to `dim` = active-feature count, (b) when ≤6 active features draws **upright** 11px names with the **latest raw value** beneath each (e.g. cpu 0.57 · mem 0.32 · temp 49.60 · disk 0.14), color-coded by the latest z (red/amber/white), (c) caps box half-width at 24px so few features don't stretch absurdly, larger outlier dots, and (d) fallback `curZ` uses `features` slice when a row lacks `z`. Rotated labels remain for >6 features; label text now shows "z per active feature (N)".
- Verification: `node --check` clean, no dup ids, all `q()` refs resolve. No backend change.

## Follow-up round 22:35 — stale "planned DB" note in Host & runtime neofetch

- The `neo-nvme` footer of the Host & runtime card used the stale "warehouse sqlite DB planned on NVMe hardware" line. Replaced with a live line rendering the **real path** from `whSql.path` + a green "live" mark (falls back to "no path synced yet"). Matches reality — the DB now lives on the Pi NVMe.
- Verification: `node --check` clean.

## Follow-up round 22:45 — pipelines page stream section → dashboard format

- Removed the four per-card `.mini` boxes and replaced them with a single full-width **Pipeline live stream** card (`pipe-stream-card`) using the exact dashboard Live-activity format: `.log` widget (dark `#1b1b1b` bg, 12px mono, colored time/tag/msg), header + Clear button (`btnClearPipeStream`), 300-row cap.
- Stream sources: realtime WS (`routePipes` → categorized tags `req / llm / wh / ml / upd / gw / sys`) plus keyword-matched gateway log history/realtime (`routeLogLine` → `inf / upd / ml / wh / sys`, single category per line now, no dup pushes) — same pipeline the dashboard streams card uses. History backfill via `loadLogHistory` populates it on load.
- Removed dead `.mini` CSS (styling + compact). Added `body.compact #pipeStream { max-height: 150px }`.
- Verification: `node --check` clean; no dup ids; every `q()` ref resolves; old `pstream-*` ids gone; `pipeStream`/`btnClearPipeStream` present.