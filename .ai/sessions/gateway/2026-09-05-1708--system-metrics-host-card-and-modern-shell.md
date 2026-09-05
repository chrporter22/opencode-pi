# System metrics, API/min, log window, Host card, modern shell

- **Date:** 2026-09-05
- **Developer:** opencode
- **Topic:** gateway — Control Center v2 continued
- **Status:** implemented + live-verified (tests 55/55, `tsc --noEmit` clean)

## Summary

Continued Control Center v2 with a system-metrics surface, a richer log window, a
fastfetch-style Host card, and a modernized "alive" UI shell (sidebar + bottom status bar +
per-card accents).

## Decisions (confirmed this session)

- System card tabulates CPU % / memory % (Viridis load ramp), temperature, disk, token rate,
  and a rolling **API calls/min** (`requestsPerMinute`, start requests within 60s).
- **Log window:** tagged, colored, auto-scrolling, 300-line cap, Clear button.
- **Error drill-down:** error status chips in the streams table expand the request reason.
- **Host card:** new `GET /api/system/host` returning *container-visible* host info — real Pi
  hardware (Model line, Cortex-A76 CPU, kernel, uptime, memory, local IP) via `/proc`, while
  OS + hostname reflect the container image. No host-path mounts added.
- **Modern shell** (user referenced nvim / snacks-dashboard): fixed left sidebar with
  scrollspy section links collapsing to a rail on narrow screens; fixed bottom status bar
  (gateway/llama/model chips, CPU %, mem %, tok/s, API/min, 1s clock, theme toggle); per-card
  accent colors; subtle glow/hover/pulse. Single-file vanilla UI preserved; Dark/Viridis
  toggle kept (now also mirrored in the status bar).

## Work log

1. **Requests-per-minute:** `requestsPerMinute()` + pure `countRequestRate(startTimes, now,
   windowMs)` in `requests.ts`; wired into `GET /api/system`, `GET /api/metrics`, and the
   `system.metrics` WS payload. Tests for the pure function.
2. **Host endpoint:** new `gateway/src/hostinfo.ts` (`readHostInfo()`: `os`, platform,
   hostname, kernel, arch, uptime, `/proc/cpuinfo` model + core count, memory total, local
   IPv4); route `GET /api/system/host` in `routes/control.ts`; `test/hostinfo.test.ts`.
   Live-verified: `{"hostname":"…","os":"Debian GNU/Linux 13 (trixie)","kernel":"6.12.58-1-rpi",
   "arch":"arm64","model":"Raspberry Pi 5 Model B Rev 1.1","cpuModel":"Cortex-A76",
   "cpuCores":4,…}`.
3. **UI (`gateway/public/index.html`):** System card table + `renderSystem` from
   `/api/system` + `system.metrics`; Host card + `loadHost()`; log window (`#log`, `evt`
   rows, tags, Clear button, auto-scroll, 300 cap); clickable error rows toggling an
   `errDetail` row; grid layout reordered so streams sit directly above the log.
4. **Modern shell:** `.shell` flex wrapper; `aside.sidebar` with brand + `nav.side-nav`
   links (colored `.marker` dots); `main.content` + `.topbar` (status dot pulsing in the
   H1); `.statusbar` built by `buildStatusbar()` rendering live chips + metrics + clock +
   theme toggle; scrollspy via `setupScrollspy()` (scroll/resize listeners, `active` class);
   per-card accent classes `ac-conn/sys/model/host/pg/stream/evt` (3px top border + tinted
   h2, hover glow/lift); wide layout 3-col grid, `@max-width:900px` sidebar collapses to a
   54px rail. No backend/dependency changes for the shell.

## Verification

- `npm run typecheck` clean; vitest **55/55** (adds `requests` rate + `hostinfo` tests).
- Page HTTP 200 (served from container); all new markers present in served HTML; extracted
  `<script>` passes `node --check`; HTML parser reports balanced tags.
- `/api/system/host` live-checked against the running `gateway-dev`.

## Follow-ups / notes

- `.ai` session/decision files updated per user request at session end (docs now cover the
  system metrics, API/min, log window, Host card, and modern shell).
- PRD §6.12 #51–55 + §7/§8/§9.8 and README Control Center section updated to match.
- Next plausible step: none pending; optionally verify visual aesthetics in a browser
  (agent verified structure/live data, not pixel rendering).