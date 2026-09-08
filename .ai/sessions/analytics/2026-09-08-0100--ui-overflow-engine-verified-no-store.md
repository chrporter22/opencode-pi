# Page overflow: engine-verified clean + no-store cache fix

Date: 2026-09-08 · same local session

## What the user reported
Still "won't fit on page"; claimed F12 (devtools) "didn't work". Asked me to go
slow, find the issue, make the change.

## What I actually did (measured with real engines)
Reproduced layout with both Playwright chromium AND playwright firefox inside a
throwaway `node:22-trixie-slim` container (network opencode-pi_default, gateway
reachable as `gateway-dev:8080`):

- Swept viewports 1440→420px at zooms 1, 1.25, 1.5, 1.75, 2.0 (CSS zoom
  injected to emulate Linux display scaling / min-font-size).
- Result: ZERO page/section overflow at every size in BOTH engines. Includes the
  documents section (tables wrapped in `.table-scroll`, cards have
  `overflow-x:auto`). The one real overflow found earlier (topbar actions row
  `flex:1 0 auto` → `flex:1 1 auto; flex-wrap`) was already fixed and holds.
- The served document already contained the fixes (checked via curl markers)
  and is revalidated via ETag with `max-age=0`.

## Conclusion
- No layout bug remains in the shipped page. The likely user-side cause is a
  stale copy in their Firefox (or a stylesheet-injecting addon).
- I could not run Firefox on the Pi host directly (no host deps/root), so the
  container fixture is the definitive check harness.

## Changes made this round
1. `gateway/src/index.ts`: static serving now sends **`Cache-Control: no-store`**
   for everything under /public, so Firefox can never serve a cached copy of the
   UI again (previous `max-age=0`+ETag could still be 304-served if a buggy/
   forced cache path was in play). Remove the cache variable altogether.
2. `gateway/public/index.html`: added `html { overflow-x: hidden; }` (belt and
   braces for any addon-injected bleed; body already had it).

## Verification
- `tsc --noEmit` clean; vitest 68/68.
- Header confirmed `Cache-Control: no-store`; `html { overflow-x }` present in
  served body.
- m6 sweep (chromium + firefox, 540/480/420 + 1.75/1.5 zoom): no overflows.

## Reusable harness (survives compose recreates, host-side)
- /tmp/opencode: `npm i playwright` + proxies/scripts measure.mjs, measure2.mjs,
  measure5.mjs, m6.mjs. Browsers cached at ~/.cache/ms-playwright
  (chromium_headless_shell-1243, firefox-1543 — firefox zip name:
  firefox-ubuntu-24.04-arm64.zip, downloaded directly from
  playwright.download.prss.microsoft.com after the azureedge 307).
- Run: single `docker run --rm --network opencode-pi_default
  -e PLAYWRIGHT_BROWSERS_PATH=/browsers -v /tmp/opencode:/oc
  -v ~/.cache/ms-playwright:/browsers:ro -w /oc node:22-trixie-slim
  apt-install-libs && node m6.mjs` (the lib list is in the last command).

## User-side
- To force the fresh page now: **Ctrl+Shift+R** (hard reload bypasses cache) —
  Firefox's F12 must show the Network tab with "Disable Cache" ticked while
  open; if F12 does nothing, it's a desktop-shortcut conflict — use menu →
  More Tools → Web Developer Tools, or about:config
  `devtools.toolbox.host`.