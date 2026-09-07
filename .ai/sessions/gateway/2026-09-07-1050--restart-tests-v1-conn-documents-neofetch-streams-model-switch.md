# Restart-test fix, opencode /v1 connection, Documents page, neofetch art, dashboard streams, 4-bit/32768 switch

- **Date:** 2026-09-07 (~09:00–10:50)
- **Topic:** gateway (UI + control plane + model-runtime)

## What was done

### 1. llama-restart test failures -> fixed and green (62/62)
- Root cause: `gateway/test/helpers.ts` `makeConfig()` built `llama` without `url`, so
  `waitForHealth` -> `healthUrl(undefined)` -> `undefined.replace(...)` threw on every poll
  -> llama never reached "ready" -> 5× "timed out waiting for llama" in
  `test/llama-restart.test.ts`. Production `parseConfig` always sets `url`, so no prod impact.
  Dockerfile.dev has no test step; the "test fails at build" report was these vitest failures.
- Fix 1 (`helpers.ts`): after merging overrides, derive `cfg.llama.url` from host/port.
- Fix 2 (`llama-restart.test.ts`): the "crash respawn" case had a test race — right after
  `process.kill()`, the parent had not yet reaped the child, so `state.llama` was still
  `"ready"` and `waitForReady` returned before the respawn's pid was logged (acked via a
  debug script that showed ready at kill-time then a second pid ~1.2 s later). Added
  `waitForPidCount(pidlog, 2, 15000)` after the kill so the backoff respawn lands first.
- Result: `llama-restart` 5/5; full suite 62/62. (Drop-in verification used
  `docker compose run --rm gateway-test npx tsx <scratch>.ts`.)

### 2. Model 4-bit + context 32768 (user executed the swap themselves)
- Verified via HF API that the official `Qwen/Qwen3-1.7B-GGUF` repo ships only Q8_0; the 4-bit
  file is the community `bartowski/Qwen_Qwen3-1.7B-GGUF` `Qwen_Qwen3-1.7B-Q4_K_M.gguf`
  (1,282,439,584 B), blob SHA-256 `72c5c3cb…b24fb` — matches the scripts' pinned default.
- `gateway/src/config.ts`: `LLAMA_CONTEXT_SIZE` default `8192 -> 32768` (Qwen3-1.7B max;
  repo `.env` already had 32768). Tests updated to the new default.
- README (§5 opencode config + §7) and PRD (§10.7) updated to Q4_K_M + 32768 as the current
  target. KV at full 32k ≈ 1.8 GB f16 on the 15 GB Pi — fine.
- User ran the install themselves: `/opt/qwen-model/current.gguf` is now the 1,282,439,584 B
  Q4_K_M file. Side effect: install left `.env` root-owned 0600, which blocks `docker compose`
  for `pi5_nvme` — pending `sudo chown pi5_nvme:pi5_nvme .env` + `docker compose up -d --build`
  (see Open issues).

### 3. opencode agent connection (quick-sync wired)
- Card `conn-oc` "opencode agent": endpoint `localhost:8080 /v1/chat/completions`, auth
  inference-key Bearer, model row + latency + last-sync ids (`cOc[cLLat/oSync]`, `cOcModel`).
- CHECKS entry `oc` hits `/v1/models` with `Authorization: Bearer <inferenceKey>` and reports
  the served model id(s). New `needInference` flag: skipped with a warn note when no inference
  key is set (`iKeyInput`/`localStorage "inferenceKey"`); `runCheck`/`syncAll` now thread `ikey`.
- `CONN_ID_MAP` gained `oc`; `renderConnections` fills `cOcModel` from `modelMeta`.

### 4. Documents page (`data-view="documents"`; sidebar under Tools, before Playground)
- Overview card: architecture (opencode agent -> /v1 -> gateway -> llama-server in container),
  control/inference planes, provisioning scripts, NVMe storage, analytics status.
- Endpoints table: `/health`, `/v1/models`, `/v1/chat/completions`, `/api/status`, `/api/model`,
  `/api/model/restart`, `/api/model/update`, `/api/system`, `/api/system/host`, `/api/metrics`,
  `/api/logs`, `/api/requests`, `/ws`.
- Environment-variables table mirroring `config.ts` (context default 32768, MODEL_URL/MODEL_DIR
  etc.). New `table.doc` / `.prose` CSS.

### 5. neofetch ASCII art — replaced with canonical neofetch art
- The hand-drawn "fastfetch-style" shapes were rejected ("do not render correct"). Extracted
  the canonical `Arch` (19 lns) and `Debian` (17 lns) arts straight from dylanaraps/neofetch
  `ascii` data (color tokens `${c1}/${c2}` stripped) and embedded them verbatim in
  `renderNeofetch`.

### 6. Dashboard live streams
- Card `dash-stream-card` (ac-evt full) with `#dashStream` (max-height 170 px).
- `appendLog` refactored into shared `appendEvt(container, type, text, level, reqId, cap)` +
  `appendLog` (log view, cap 400, keeps logLevelPass filter) + `appendStream` (dashboard, cap 200).
- WS onmessage mirrors `log` events and all `request.*` events to the dashboard stream (skips
  `system.metrics` noise).

## Verification
- HTMLParser balance: clean. `node --check` on extracted `<script>`: OK.
- DOM smoke harness `/tmp/opencode/neo-smoke.js` (+ `neo-inject.js`, `pi-index.js`): 21/21 PASS
  (canonical art present, old shape gone, docs nav/view + 32768 + endpoints, opencc card/check,
  stream card + appendEvt wiring).
- Backend: `npm run typecheck` clean and vitest 62/62 (both before the UI-only edits — no backend
  file changed since).

## Open issues / next
- `.env` is root-owned 0600 after the user's `sudo ./scripts/install.sh`; needs
  `sudo chown pi5_nvme:pi5_nvme .env` then `docker compose up -d --build gateway-dev` to serve
  the Q4_K_M model at `--ctx-size 32768` (llama args rebuild via supervisor).
- opencode's `~/.config/opencode/opencode.json` on the laptop: model `opencode-pi/Qwen3-1.7B`
  with `context` limit 32768 per README §5.
- Not started across the session: analytics microservice (PRD §6.13), model auto-update tuning.

## Decisions recorded
- `.ai/decisions/model-runtime/2026-09-07--model-swap-q4km-confirmed-context-32768.md`
- `2026-09-06--model-swap-q4km-target.md` (context) advanced by the above.