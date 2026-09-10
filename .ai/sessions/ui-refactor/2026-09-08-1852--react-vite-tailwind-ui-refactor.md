# Session: React + Vite + Tailwind UI refactor (done — swapped)

Date: 2026-09-08 18:52 · status: completed (implementation + verification + swap)

## Request (user)
- Refactor the entire control-center UI — one giant vanilla `gateway/public/index.html`
  (3481 lines, inline CSS+JS) — into a TypeScript React + Vite + Tailwind app.
- "Sleek, modern" rebuild keeping ALL sections and tools.
- Review grouping of tools/pages, propose what fits where.
- Long-browser-session efficiency ("like a Supabase frontend").
- ML card: replace PCA/EWMA risk label with TF-Lite inference output (three class
  probabilities + class).

## Work done
1. **New SPA at `ui/`** — React 18 + Vite 5 + Tailwind. 9 views (Overview ·
   Infrastructure · Pipelines · Warehouse · Logs · Metrics · ML Analytics ·
   Playground · Documents), 4 themes, compact toggle, fixed rail + status bar,
   JetBrains Mono. Data via `/api` 5s refresh (visible-gated) + `/ws`. All legacy
   tools/panels preserved and re-styled. GA-zero gateway runtime changes.
2. **Containerized tooling kept** — `ui-dev` compose service (Vite dev proxy,
   `allowedHosts` required by Vite 5.4 for non-localhost Host headers), Dockerfile
   `ui` build stage, `postcss.config.cjs→.mjs` (ESM fix), `ui/package-lock.json`
   generated. All npm/tsc/vite/vitest run in node containers.
3. **ML Analytics view** — NN scorecard (class + probability bars primary, PCA/EWMA
   rows secondary), LiveCard, pipeline-flow card, 3D PCA explorer (drag/wheel/hover
   pin, dim cycle, spin, viridis, red halo ≥high, white pin ring), drift/T² history
   canvas, feature box-plots, telemetry sparks, TrainingCard, ModelsTable, ConfigCard.
4. **Bugs found by typecheck/build/sweep and fixed:** `useStoreSlice` getSnapshot
   caching (inline selector objects looped `useSyncExternalStore`; snapshot keyed by
   store-state ref — critical), Spark `hexAlpha`→`colorWithAlpha` (CSS vars can't go
   into `addColorStop`; resolves to `rgba(...)`), viridis tuple typing, dead `watch`
   var, `latMs`/RequestRecord/LogEntry/opsStore typing, TrainingCard run keys,
   Overview static `api` import.
5. **Swap (one-shot).** `ui/dist/{index.html,assets}` → `gateway/public/`. First
   attempt served a STALE dist (built before the store/spark fixes) → React #185
   loop; rebuilt then re-swapped. Express serves the live files (Cache-Control
   no-store) — no gateway restart.

## Verification (Playwright, `pi-sweep` container, prod path `gateway-dev:8080`)
- Full SPA sweep: all 9 views render, data populated, zero console/page errors,
  wsOk + wireOk (21 rows), overflow `[]`, all 8 ML canvases painted.
- Overflow matrix (all 9 views × 320/420/480/540/600@1.5/700@1.5/900@1.25):
  `doc.scrollWidth === innerWidth` everywhere — zero page-level horizontal scroll.
- Narrow-width card clipping fixed: spark/cfg/feat grids `minmax(min(N,100%),1fr)`,
  PCA captions flex-shrink + truncate, config input `min(240px,100%)`, `table.stats`
  `table-layout:fixed` + ellipsis.
- `npx tsc --noEmit` clean, `vite build` clean (244 kB JS / 29 kB CSS),
  vitest 8/8 (fmt lib).
- Legacy baseline (pre-swap): 10 sections, zero overflow, zero errors —
  parity confirmed.

## Known limits / notes
- Card-level `overflow-x:auto` keeps nowrap table values scrollable inside cards at
  ≤480px (fixed 220px rail, parity with legacy); page never scrolls. Deep-mobile
  redesign out of scope.
- Google Fonts link in built index.html is identical to legacy — no new external dep.
- Current model can't view screenshots; visual QA relied on DOM/canvas/console asserts.
- `ui-dev` service still up (compose); harmless. Rollback: `git checkout` on
  `gateway/public/*` / backup `/tmp/opencode/legacy-index.html.bak`.

## Follow-up run (same session): production artifact validated
- Built the full production image (`docker build --target runtime`, tag
  `pi-gateway-prod`) and booted it on the compose network (port 18080, `.env`,
  llama/models/os-release mounts). HEALTHCHECK healthy; loads the real GGUF.
- SPA + overflow sweeps against the prod image: zero errors, ws/wire ok (21 rows),
  `doc === innerWidth` at all widths — same result as dev verification. The
  Dockerfile `COPY --from=ui /app/dist ./public` bakes the current UI correctly.
- Long-session soak (10 min + 3 min passes, prod image, view flip every 20-30s):
  JS heap flat at 10 MB max, DOM steady (~420 nodes, no leak), WS connected once
  and stayed open (no reconnect churn), zero console/page errors.
- Housekeeping: `ui-dev` service stopped (still in compose for future dev);
  `pi-gateway-prod-test` container removed; image `pi-gateway-prod` kept.
- AGENTS.md now carries the project-specific UI rules block (rebuild→re-copy→
  re-sweep discipline, regression bar).
- Sweep/soak harnesses in `/tmp/opencode/`: `ui-sweep-spa.mjs`, `ui-overflow.mjs`,
  `ui-overflow-detail.mjs`, `ui-soak.mjs`, `m6.mjs`, image `pi-sweep`.

## Open threads
- Working tree left uncommitted per user instruction: `ui/` + swapped
  `gateway/public/{index.html,assets/}` + Dockerfile + compose + memory files.
  Optional next: commit (ask user), or delete `/tmp/opencode` + `pi-sweep` once
  the regression harness is no longer needed.