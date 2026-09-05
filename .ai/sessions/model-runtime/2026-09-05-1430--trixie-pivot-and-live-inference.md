# Container-runtime pivot to trixie + llama inference fix + script hardening

- **Date:** 2026-09-05 14:30
- **Developer:** opencode
- **Topic:** model-runtime
- **Preceding:** 0102 (M2 plan), 0150 (M2 pipeline build), 0230 (install-script fix +
  laptop setup). This session closes the live-acceptance / llm-runs-in-container thread.

## Request

User provisioned `/opt/llama`, brought up the gateway, and reported the UI showing
"status is false". Goal: get llama-server actually serving inside the container on a bookworm
base; when that failed, pivot to a container base that can run the released llama binaries;
harden the install scripts so an incompatible release can never break the running gateway;
update the README and record decisions.

## What happened

### 1. Live acceptance failed: llama could not start in the container

- `docker compose up -d` → gateway online, but `llama":"error"`. Log:
  `error while loading shared libraries: libssl.so.3: cannot open shared object file`.
- C (read-only) confirmed isolation: **container** (`node:22-bookworm-slim`, Debian 12,
  glibc 2.36) had neither `libssl.so.3` nor `libcrypto.so.3`; **host** (Arch Linux ARM,
  glibc 2.42) had both. So the binary ran natively but not in the slim container.
- Added `libssl3` to both Dockerfiles and rebuilt. Next error: `libgomp.so.1` missing.
- A full `ldd` pass over `/opt/llama/*` revealed the real blocker: the b9500 arm64 build
  requires `GLIBC_2.38`, `GLIBCXX_3.4.32`, `CXXABI_1.3.15` — bookworm ships glibc **2.36**
  and libstdc++ 12.2, so **no number of extra packages can fix it**. This was not a
  package problem; it was a toolchain/base mismatch.

### 2. Option 1 (install an older release) was disproven

- Probed the releases API + asset URLs across the arm64 window:
  - `b7500`, `b7000`, `b5000` — release tags do not exist (404).
  - `b6000` — exists but publishes **no arm64 Linux asset**.
  - `b9000` — first tag with `llama-...-bin-ubuntu-arm64.tar.gz`, and it **also** needs
    `GLIBC_2.38` (verified by running it in the bookworm image).
- Conclusion: **every published arm64 Linux binary is built with the newer glibc>=2.38
  toolchain**; there is no released arm64 build that runs on bookworm (glibc 2.36).
- The work was not wasted: testing candidate binaries on newer images pinpointed the fix.

### 3. Pivot: trixie base (validated before adopting)

- Tested b9000 in `node:22-trixie-slim` (Debian 13, glibc 2.41): **no missing libs**, runs.
- Tested the already-installed b9500 in the same image: needs `libgomp1` (its build config
  differs from b9000). With `libgomp1` installed it runs: `version: 9500 (3d1998634)`.
- Decision: switch both Dockerfiles `node:22-bookworm-slim` → `node:22-trixie-slim`, add
  `libgomp1` (replace the libssl3 lines). Keep the existing b9500 pin + `/opt/llama` — no
  reinstall needed. Verified / updated standalone (see decision file).

### 4. Real integration bug surfaced once llama was live: proxy ate the request body

- After the pivot, `/v1/models` proxied fine but `POST /v1/chat/completions` hung forever
  (curl rc 124, no llama activity). Direct llama hit inside the container returned 200 in
  ~6 s.
- Root cause: `app.use(express.json())` was registered globally at
  `gateway/src/index.ts:31`, **before** the `/v1` proxy router. Express is ordered
  declaratively — the JSON body parser consumed the request stream, so `http-proxy` piped an
  empty body and llama never got the request. GET `/v1/models` worked because it has no body.
  This was entirely latent code from the scaffold; it only surfaced now that a live llama
  sits behind the proxy.
- Fix: scope `express.json()` to `/api` only (added inside the `/api` router chain, after
  `requireAuth`). Rebuild not required for dev (`tsx watch` hot-reloaded), but a clean
  `docker compose up -d --build` confirms it.

### 5. Verified live acceptance (all green)

- `/api/status` → `{"gateway":"online","llama":"ready","modelLoaded":true}`.
- `GET /v1/models` → `data[0].id == "Qwen3-1.7B"` (alias works), `n_ctx 8192`.
- Non-stream + SSE stream completions both return tokens (Qwen3 think/reasoning tokens flow).
- `/api/system` → `tokensPerSecond ~2.4–2.8` at ctx 8192 / 4 threads (Qwen3 think-mode on).
- **42/42 vitest pass**; `tsc --noEmit` clean.

### 6. Install/update scripts hardened with a container-runtime gate

- Problem: the old `--version` sanity check ran **on the host** (glibc 2.42), so it accepted
  a binary that could not start in the container — exactly the failure that shipped M2.
- Added `runtime_check()` in both scripts: runs the staged binary on the host AND inside
  the gateway's runtime image (`LLAMA_RUNTIME_IMAGE`, default `node:22-trixie-slim`, with
  `libgomp1` installed inline to mirror the Dockerfiles) + `ldd | grep "not found"` + run.
- `stage_and_swap()`: download → extract → stage under `.llama.$$` → verify → only then swap
  into `/opt/llama`. Any failure leaves the current install untouched (`trap ... RETURN`).
- Top-level resolution now: on a failed target release, warn + fall back to the default pin;
  if the default also fails, hard-error and leave the install untouched.
- Sandbox-verified all four paths in `/tmp` (no sudo, `LLAMA_DIR` overrides):
  - default b9500 → installs (passes trixie gate), `version: 9500`.
  - `LLAMA_RELEASE=b10000` → **passes** trixie gate (its glibc 2.41 build also runs), installs.
  - `LLAMA_RELEASE=b10000` with `LLAMA_RUNTIME_IMAGE=node:22-bookworm-slim` → rejected →
    falls back to b9500 → b9500 also rejected → aborts, install untouched.
  - `update.sh` on a working b9500 with the bookworm check image → preserved the working
    binary after a failed attempt (`version: 9500` remained).
- README documents the gate and the `LLAMA_RUNTIME_IMAGE` override.

## Current state

- Gateway container running on trixie, llama `ready`, both streaming and non-stream
  inference working end-to-end, model id `Qwen3-1.7B`.
- README: base-image note, run/clean docker-compose directions, release-selection + runtime
  gate notes, E2E acceptance checked off, laptop section re-titled (no longer a leave-off).

## Open threads / next steps (user-side)

- Remove the leftover root-owned empty dir from the experiment:
  `sudo rm -rf /tmp/opencode/llama-test` (tarballs already deleted, ~0 disk).
- Git: still not a repo; user initializes/commits/pushes themselves.
- Laptop opencode config (`~/.config/opencode/opencode.json`) — instructions in README.
- `AUTO_UPDATE_MODEL` remains parsed-but-unscheduled (out of scope, as before).
- Tok/s is modest (~2.4–2.8) because Qwen3 think-mode + 4 threads; raising
  `LLAMA_THREADS` is a possible tuning follow-up if throughput matters.