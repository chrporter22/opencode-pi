# Neofetch System Card with Dual OS + NVMe Mounts

## Status
Done — implemented, verified (tests + smoke), memory persisted. Not committed (per user directive: write `.ai` instead of committing).

## What & why
User wanted a neofetch/fastfetch terminal-style ASCII card on the System metric card and the Metrics panel, to "feel like arch linux". Clarification: host OS outside docker is **Arch Linux ARM (rpi-linux)**, container headers are **Debian trixie** (`node:22-trixie-slim`), and the card should show BOTH plus NVMe mount details (SQL warehouse DB will live on the NVMe hardware).

Discovery during planning: the gateway container cannot see the host OS or host mounts — `hostinfo.ts` reads the container's `/etc/os-release`, `/proc/cpuinfo`. So a real-data probe needed a small backend/compose addition, not just UI.

## Changes
- **docker-compose.yml** (`gateway-dev` only): two read-only file mounts → `/etc/os-release:/host-os-release:ro` and `/proc/mounts:/host-mounts:ro`. Precedent: `hostinfo` can read real host OS name + mount table.
- **gateway/src/hostinfo.ts**: added `hostOs` (reads `/host-os-release`, fallback `null`) and `mounts: {device, mount, fs}[]`; new pure `parseMounts(contents)` filters device-mounted entries (`/dev/*`), decodes `\040`, dedupes, falls back to `/proc/mounts`. Exposed automatically via existing `/api/system/host`.
- **gateway/test/hostinfo.test.ts**: 2 new `parseMounts` tests (physical-device extraction, escape decoding, overlay/tmpfs filtering, dedupe) + asserts for new fields.
- **gateway/public/index.html**:
  - `renderNeofetch()` — single JS builder writing into every `[data-neo]` container (Dashboard System card + new Host & runtime card in Metrics view), no duplicate ids.
  - Two neofetch panels: **Host · Arch** (hostOs, kernel, uptime, cpu, mem%+temp from live metrics, Pi model, arch, IP) with Arch-blue curly-triangle ASCII; **Runtime · Debian trixie** (image, container os, gateway, llama, model name/quant, size, loaded) with Debian-red swirl ASCII. NVMe strip below: model volume `/models` usage (used% + free), filtered mount list (nvme/root/home), note that warehouse sqlite DB is planned on NVMe.
  - Reuses `sysState`/`hostState`/`lastStatus`/`modelMeta` caches (`hostState` is new); re-rendered from `renderSystem` (keeps %+temp fresh via WS) and `loadHost`.
  - New `hHostOs` row in the Host card (Connections view) showing the real host OS.

## Verification
- `docker compose run --rm gateway-test npm run typecheck` — clean.
- Vitest: hostinfo scoped 3/3; full suite 57 passed / 5 failed = pre-existing `llama-restart.test.ts` timing timeouts (unchanged since earlier sessions).
- HTML tag balance OK; extracted `<script>` `node --check` OK; DOM-shim smoke (`/tmp/opencode/neo-smoke.js` + `neo-inject.js`) — 11/11 checks PASS with simulated host/mount/model data.

## Remaining
- Live UI check pending: `docker compose up -d --build gateway-dev` then open Dashboard System card + Metrics → Host & runtime. Container must be rebuilt to mount `/host-os-release` + `/host-mounts` (plain `restart` won't add volumes).
- Not committed; carried-over uncommitted work from tasks 1–3 still in tree per user directive.