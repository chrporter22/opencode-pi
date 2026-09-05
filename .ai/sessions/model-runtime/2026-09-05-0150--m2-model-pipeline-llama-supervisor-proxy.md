# M2 model pipeline, llama supervisor, /v1 streaming proxy (1/2)

Date: 2026-09-05
Milestone: M2 — model runtime + inference
Status: code complete; live acceptance in progress (model download running)

## What was done

### M2.3 host scripts verified (real /opt install deferred to user)
- `scripts/{install.sh,update.sh,cleanup.sh}` had `chmod +x` applied and were run in a
  sandbox (`LLAMA_DIR=/tmp/... MODEL_DIR=/tmp/... LLAMA_RELEASE=b9500`), no sudo.
- **Bug found & fixed:** current llama.cpp arm64 releases ship `libllama-server-impl.so`
  (+ ggml SIMD libs, many armv8.x/armv9.2 variants) that must sit **next to the binary**;
  installing only `llama-server` fails with
  `error while loading shared libraries: libllama-server-impl.so`. Both scripts now `cp -a`
  the **whole extracted bin dir** into `$LLAMA_DIR` (stage-dir + verify `--version` + copy).
- `llama-b9500-bin-ubuntu-arm64.tar.gz` verified running on the Pi host (`version: 9500`,
  GNU 14.2.0 aarch64, exit 0). b9500 pinned for tested installs; scripts still default to
  latest-stable resolution via GitHub API with `b10447` fallback.

### M2.4 model pipeline (no network needed in unit tests)
- `gateway/src/model/types.ts` — ModelContext, ModelMetadata, ModelEvents (log + progress).
- `gateway/src/model/model-store.ts` — `hashFile`, `readMetadata`, and `installModelFromFile`
  (SHA-256 verify → stage under `.download/` → atomic `rename` swap → cleanup staging).
- `gateway/src/model/actions/update-model.action.ts` — stream download via fetch →
  per-transform progress (`content-length` based) → `installModelFromFile`.
- `gateway/src/model/actions/ensure-model.action.ts` — skip if `current.gguf` present;
  download if missing + `MODEL_URL`; warn-and-leave if missing + no URL.
- Bootstrap: `index.ts` runs `ensureModelAction` after the listener starts;
  `state.setModel("loading"→"loaded"|"error")`, logs go through the ring logger.
- `/api/model` now built from `readMetadata` (async) instead of `statSync`.

### M2.5 llama supervisor
- `gateway/src/modules/llama/supervisor.ts` — `buildLlamaArgs` (pure), `waitForHealth`
  (polls `GET {base}/health`, abortable), `createLlamaSupervisor`:
  spawn with `stdio` pipes, stdout→info/stderr→warn streaming through the ring logger,
  stderr regex parse of llama `timings` → `state.setTokensPerSecond`,
  health-poll → `setLlama("ready")` + `setModelLoaded(true)`,
  on exit → backoff respawn (`1s,2s,5s,10s,20s`), after 5 consecutive failures →
  `setLlama("error")` until a manual restart, `restart()`/`stop()` terminate the child.
- WS events need no new wiring: `ws.ts` already broadcasts every `RuntimeState` change.
- Supervisor is created before the routers and started after `bootstrapModel()` resolves
  (llama only spawns once the model file is in place).

### M2.6 `/v1` streaming proxy
- `gateway/src/routes/v1.ts` — mounts as `/v1/*` after inference-key auth; uses the existing
  `http-proxy` dep; `proxyReq` strips `authorization` before forwarding so credentials never
  reach llama-server; 503 JSON while `state.llama !== "ready"`; on upstream error →
  drain-or-502. SSE streams through untouched.

### M2.7 lifecycle endpoints
- `POST /api/model/restart` → `llama.restart()`.
- `POST /api/model/update` → in-flight guard (409), `updateModelAction` with progress/events
  to the ring logger, then `llama.restart()` to reload the new file.
- tok/s now wired end to end: llama `timings` → state → `/api/system` + WS + control center.

### Control center
- `gateway/public/index.html` upgraded: model panel with installed/size/status/tok-s,
  download progress bar fed by WS log events, `Restart model` / `Update model` buttons.
- Shipped before live acceptance so the download progress is visible during first boot.

## Verification
- Typecheck clean (`tsc --noEmit`), **42/42 tests pass** across 7 files. New files:
  `model.test.ts` (9, network-free — injectable `fetchImpl`, real SHA-256 verify + mismatch),
  `llama-supervisor.test.ts` (4 — args + health poll against a live local stub server),
  `v1-proxy.test.ts` (2 — 503 gating + SSE streaming + upstream auth-strip check),
  `test/helpers.ts` (`makeConfig` shared by the two new suites); `routes.test.ts` was updated:
  the old 501-stub assertions became restart/update behavior tests.
- Live smoke: gateway booted in dev at :8080; `/health` open; `/api/model` returns Qwen3-1.7B
  metadata with `installed:false` on first boot; `/v1/chat/completions` correctly 503s while
  downloading; `state.setModel` events flow over `/ws`.

## Unfinished / next
- The 1.83 GB Qwen3-1.7B-Q8_0.gguf download is running into `/opt/qwen-model` (host `managed
  by root` bind mount, container runs as root so writes work). On completion: SHA-256 verify +
  atomic swap + llama boot from `/opt/llama` (still EMPTY — needs user `sudo ./scripts/install.sh`).
- Once downloaded & llama ready: streaming `curl` completion through `/v1` (SSE), tok/s in
  `/api/system`, WS events, control center progress/restart/update smoke.
- Decide M2.8 acceptance formal result and any README/memory final polish.

## Open questions (for the user)
- None blocking. `AUTO_UPDATE_MODEL` config is parsed but not scheduled yet (no auto-update
  timer was in the approved M2 plan) — flagged for a future milestone.

---

## Finalization addendum (same session)

- **Model download completed live (M2.4 acceptance):** the 1.83 GB
  `Qwen3-1.7B-Q8_0.gguf` was streamed into `/opt/qwen-model`, SHA-256 verified to
  `061b54da…cb1a` (exact match), and atomically swapped to `current.gguf` (staging dir
  removed). The full download → verify → rename pipeline works end to end.
- **Prod image smoke:** `docker build` succeeds; container boots with `/health` open,
  `/api/status` → `{gateway: online, llam: not_started}`, `/v1` returns 503 until ready.
  (Bare `docker run` without model mounts correctly begins a first-run download inside the
  container.)
- **`.gitignore` extended at repo root** (explicit user request): added `coverage/`, `*.log`,
  `logs/`, `*.gguf`, `.download/` alongside the pre-existing Node/env/OS entries.
- **Remaining acceptance blocker (user-owned):** `/opt/llama` is still empty — needs
  `sudo ./scripts/install.sh`, then `docker compose restart gateway-dev`. After that:
  streaming completion through `/v1`, tok/s in `/api/system`, control-center smoke.