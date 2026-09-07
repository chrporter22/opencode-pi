# Show real host OS + NVMe mounts in the gateway UI

Date: 2026-09-07

## Decision
The control center shows a neofetch-style "host vs runtime" panel with the real story: host is Arch Linux ARM (rpi-linux) outside docker, containers are Debian trixie, and NVMe mount/usage details are surfaced (SQL warehouse DB lives on that hardware).

To make that truthful (not hardcoded), the `gateway-dev` container now bind-mounts two **read-only host files**:
- `/etc/os-release:/host-os-release:ro` → real host OS name (`hostinfo.hostOs`)
- `/proc/mounts:/host-mounts:ro` → host mount table (`hostinfo.mounts`)

`hostinfo` falls back to the container's own os-release/`/proc/mounts` when those mounts are absent (e.g. running the gateway outside compose), which also keeps `gateway-test` green without the mounts.

## Why
The gateway container cannot see the host OS or mount table from inside; `/api/system` previously exposed only statfs of the model volume. Neofetch-style UI needs real data — the mount-file approach is minimal, read-only, and has no extra privileges beyond what file mounts allow. Earlier scope was "UI-only, no backend"; this is the one deliberate, small backend exception to enable real host/mount data.

## Note
This decision extends the side-panel UI work but is intentionally separate from the analytics/storage planned-state (sqlite + sqlite-vec external mount, redis) which remains backend-pending per PRD §6.13.