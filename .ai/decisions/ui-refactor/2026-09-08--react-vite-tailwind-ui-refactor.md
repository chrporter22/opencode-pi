# React + Vite + Tailwind UI refactor — confirmed direction

- **Date:** 2026-09-08
- **Decided by:** user (confirmed all four recommended options via clarifying questions)
- **Topic:** ui-refactor

## Decisions

1. **New UI at repo root, built into `gateway/public`.** The refactor is a new
   TypeScript + React + Vite + Tailwind app under `ui/`. Build output lands in
   `gateway/public/` (via a copy step), which the existing Express static handler
   already serves with `Cache-Control: no-store` — zero runtime backend changes.
   Single origin keeps WS + `/api` auth (`x-api-key`) and the inference key flow
   unchanged. Dev runs through a Vite dev server proxying `/api`, `/v1`, `/health`,
   `/ws` to the gateway.
2. **Containerized tooling (kept).** The existing "never run npm/tsc on the host"
   decision (2026-09-05) applies to the UI build/dev too: a `ui-dev` compose service
   (Vite) plus a UI build stage in the production Dockerfile. No host node tooling.
3. **ML scorecard shows TF-Lite inference output as the primary risk signal.**
   The NN class (normal/watch/high) plus the three class probabilities render as the
   primary indicator on both the ML scorecard and the dashboard analytics mini-card;
   probability bars show all three classes at once. The PCA/EWMA rows (Hotelling T²,
   p-value, compute/windows scored, watch/high σ context) stay as secondary detail.
4. **One-shot swap of the legacy file.** `gateway/public/index.html` stays serving
   until the new UI passes the Playwright overflow/regression sweep; then it is
   replaced by the built app in a single step. Git history keeps the old file for
   rollback. No legacy fallback route.
5. **Horizontal-overflow regression bar = page/section level.** Cards own their inner
   overflow via `.card { overflow-x: auto }`; nowrap table values stay scrollable
   within the card on narrow widths instead of pushing the page. Verified as
   `doc.scrollWidth === innerWidth` across all views/widths. Card-internal scroll is
   acceptable; deep-mobile redesign of the fixed 220px rail is out of scope (parity
   with legacy).
6. **Prod bundle must be rebuilt after code fixes.** The Vite dev server (HMR) does
   not validate the shipped dist: the first swap served a stale pre-fix bundle
   (React #185 update loop). Rule: after any source change, re-run `tsc + build` in
   a container, then re-copy `dist` into `gateway/public/`, then re-sweep :8080.

## Why

- Serving from `gateway/public` avoids touching the gateway/Express serving or the
  container mounts — the SPA is fetched exactly like the current file, so WS auth,
  key inputs, and cache behavior are untouched.
- Containerized tooling preserves the repo's environment-consistency decision on the
  Pi and matches the analytics/gateway builds; the Pi host stays clean.
- The user wants the ML card to reflect what the live TF-Lite model actually outputs
  (three softmax probabilities + argmax class, `analytics/app/nn.py` → `nnRisk` +
  `nnProb[3]`) rather than a single PCA/EWMA-derived label; the EWMA mechanics remain
  available as context rows.
- A single swap keeps `git` as clean rollback and avoids permanent dual-pane drift.

## Resolved during implementation

- Final nav IA: 9 views (Overview · Infrastructure · Pipelines · Warehouse · Logs ·
  Metrics · ML Analytics · Playground · Documents), adopted during build.

## Status (2026-09-08, end of session)

Implemented, verified, and swapped into `gateway/public/`. New UI live at :8080
(zero page errors, zero page-level horizontal overflow, ws/wire connected, 8/8 ML
canvases painted, tsc/build/vitest clean). Rollback: `git checkout gateway/public/*`
or `/tmp/opencode/legacy-index.html.bak`.