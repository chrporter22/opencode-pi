# UI overflow — real culprit was the topbar actions row, not docs

Date: 2026-09-08 · same local session

## User report
UI still "won't fit on page"; user recalled "the document section throwing it
off".

## Diagnosis (measured, not guessed)
Installed Playwright chromium-headless-shell into /tmp/opencode (host has no
sudo, but the gateway container is Debian and has root) and measured
scrollWidth vs viewport per section per viewport width, unhiding all views:

- Documents section and every other section: clean at 600–1440px. The
  `.table-scroll` + `.card { overflow-x:auto }` containment from the earlier
  round already fixed those.
- The REAL global offender: the topbar's `.row.actions` (API-key inputs +
  Theme/Compact buttons) had inline `flex:1 0 auto` → `flex-shrink:0`, so the
  638px button/key box could never shrink. At ≤~700px viewport (or any
  font-scaling/zoom that widens inputs) the shell overflows to a fixed 706px,
  spilling past the right edge on EVERY page. It appeared on docs mainly
  because headers crop there too.

## Fix
`gateway/public/index.html`: topbar actions row inline style
`flex:1 0 auto` → `flex:1 1 auto; flex-wrap:wrap` (buttons 186px wrap to a
second line instead of pushing the page wide). Re-measured: no page or section
overflow at any of 600/700/800/900/1100/1280/1440.

## Measurement harness (kept for future UI checks)
- `/tmp/opencode/measure.mjs` — scrollWidth per section + viewport sweep.
- `/tmp/opencode/measure2.mjs` — unhides all sections, reports overflow per
  section + wide elements.
- Run inside the gateway container: npm i playwright there, `docker cp`
  node_modules + ~/.cache/ms-playwright + script, then node script against
  127.0.0.1:8080. Container libs came from one-off
  `apt-get install -y libasound2t64 libnss3 libnspr4 libatk...` (Debian 13).

## Note for the user's laptop (Firefox)
If it still looks wrong after this, it's their browser showing the cached page:
F12 → Network → Disable Cache, or Ctrl+Shift+R. Their Arch Firefox dev tools are
built-in (F12); no install needed.