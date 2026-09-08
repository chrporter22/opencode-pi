# Llama server bind-fail crash loop — stale orphan vs tsx watch

Date: 2026-09-08 · same local session as 2355 batch

## Incident
UI kept showing a llama server error. Logs: llama-server crashing in a loop with
`couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8000`, restarting
every 1s "attempt 1" forever.

## Root cause
- `npm run dev` = `tsx watch src/index.ts`. Each TS edit restarts the node
  process, but its `llama-server` child is NOT killed — it survives orphaned and
  keeps binding `127.0.0.1:8000`.
- The next spawn (fresh supervisor) can't bind → exits → onExit schedules
  respawn. But `waitForHealth` polls the *orphan's* health on the same port and
  resolves, resetting `consecutiveFailures` to 0 before the crash can build up.
  So MAX_CONSECUTIVE_FAILURES is never reached and it retries forever.

## Fix (approved)
- `gateway/src/modules/llama/supervisor.ts`:
  - `isLlamaServerCmdline(cmdline, bin, port)` — pure matcher, NUL→space
    normalized (real /proc cmdline is argv-NUL-separated).
  - `reapStaleLlamaServers(bin, port, keepPid, logger)` — scans
    `/proc/[0-9]*/cmdline`, SIGTERM then SIGKILL after 1s any process running our
    bin on our port that is not the tracked child (= PID 547 class orphen).
  - `spawnLlama()` calls the reap before every spawn → orphans can never lock the
    port again, whatever killed their parent.
- Tests added in `gateway/test/llama-supervisor.test.ts` (isLlamaServerCmdline
  describe). Cmdline strings use `\0`…`\032768` pitfalls — `\0` + digits are
  octal escapes in JS; use `\0` alone or separate tokens.

## Verification
- tsc --noEmit clean; vitest 11 files / 68 passed (67→68 with 2 new assertions).
- Live: reaped PID 547 manually (via `docker exec ... node -e process.kill(...)`
  since the image has no `kill` binary); health `200 {"status":"ok"}`; healthy
  again after the tsx-watch reload took the new code.

## Notes
- Ops only + this one TS change; no docker/config changes. No rebuild needed.