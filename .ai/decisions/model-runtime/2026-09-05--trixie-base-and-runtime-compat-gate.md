# Container base on Debian trixie (glibc 2.41) to match llama arm64 binaries

- **Date:** 2026-09-05
- **Developer:** opencode
- **Topic:** model-runtime
- **Stakeholder:** user (confirmed the pivot in-session)

## Context / why

The gateway runs llama-server inside its Docker container (`node:22-bookworm-slim`). When a
live llama first came up behind it, the upstream arm64 binary failed to load with
`libssl.so.3` / `libgomp.so.1` missing, and a full `ldd` pass showed the root cause: the
released arm64 builds need `GLIBC_2.38` + `GLIBCXX_3.4.32`, but Debian 12 (bookworm) ships
glibc **2.36**. This is not fixable with packages on a bookworm base.

We first tried to install an **older** release. That is impossible:

- `b7500`/`b7000`/`b5000` tags don't exist; `b6000` publishes no arm64 Linux asset.
- `b9000` is the first tag with an arm64 binary and it too needs `GLIBC_2.38`.

So there is no published arm64 llama.cpp Linux build that runs on glibc 2.36. The host Pi has
glibc 2.42 (Arch Linux ARM), which is why it looked "tested and working" — but the container
is the real deployment target.

## Decision

- Move the gateway runtime base from **`node:22-bookworm-slim`** to
  **`node:22-trixie-slim`** (Debian 13, glibc 2.41) in **both** `Dockerfile` and
  `Dockerfile.dev`.
- Install **`libgomp1`** (OpenMP runtime) in the image; the b9500 arm64 build links it.
  (An earlier `libssl3` addition from debugging is replaced by this — trixie's libssl3 is
  satisfied by its own OpenSSL 3, so `libssl3` is no longer needed as an explicit apt add.)
- Keep the existing llama pin `b9500` and the already-provisioned `/opt/llama`; no
  reinstall required. The gate in the install/update scripts is the compatibility
  enforcement point for future releases.

## Validation

- b9500 runs in `node:22-trixie-slim` + `libgomp1` (`version: 9500`, no missing libs) —
  confirmed under `ldd` + direct run before the switch.
- After the switch: `/api/status` → `llama:"ready"` / `modelLoaded:true`; `/v1/models` id
  `Qwen3-1.7B`; streaming and non-stream completions work; 42/42 tests pass.

## Beyond tinkering side effect

This decision was originally scoped to "pick an older compatible release." That path was
empirically disproven, so this base change is the record of the actual approach taken.

## Impact

- `Dockerfile` (runtime stage), `Dockerfile.dev`, plus the docs and memory that describe
  the base image.
- The runtime validation gate in `scripts/install.sh` and `scripts/update.sh` enforces that
  any future llama release runs on `node:22-trixie-slim` + `libgomp1`.

## Notes

- Alternative considered and rejected this session: **run llama-server natively on the host**
  (Arch). Retained the single-container architecture; gateway and llama stay co-located and
  go up/down together, which matches the existing design.
- The trixie base is glibc 2.41 (Debian 13). If the toolchain upstream ever moves past that,
  the scripts' gate will surface the mismatch on `install.sh`/`update.sh` rather than
  silently failing at gateway boot.