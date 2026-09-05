# Control Center v2 implementation

- **Date:** 2026-09-05 15:51
- **Developer:** opencode (big-pickle)
- **Topic:** gateway

## Request

From the approved planning session (2026-09-05-1516--control-center-v2-planning): implement the
Control Center v2 scope — fix overlapping/clipping UI, a live inference-request streams table,
a multi-turn chat Playground, a subtle Viridis theme toggle, and JetBrains Mono typography — per
PRD §6.12 reqs 43–50, §7.1 `/api/requests`, §8 `request.*` payloads, §9.4–9.7, §20.

## What was done

- **Request tracker** (`gateway/src/requests.ts`): new `createRequestTracker()` — bounded ring
  (default 200), `start/complete/fail/subscribe/snapshot`, `RequestRecord` = id, method, path,
  model, status, startedAt, durationMs, promptTokens, completionTokens, totalTokens,
  tokensPerSecond, error. `complete()` computes `durationMs` and `tokensPerSecond` guarded.
- **v1 instrumentation** (`gateway/src/routes/v1.ts`): tracking only for `/chat/completions`.
  Readiness `503` gate preserved for all `/v1/*`. `res.write` wrapper sniffs numeric usage from a
  rolling 256-char tail; `finish`→complete, `close`→fail("client disconnected"),
  `proxy error`→fail.
- **Wiring** (`routes/control.ts`, `ws.ts`, `index.ts`): `GET /api/requests`, `request.started/
  completed/error` WS broadcasts with full payload, unsubscribe on socket close.
- **Streaming token counts** (`modules/llama/supervisor.ts`, `requests.ts`): llama-server b9500
  does NOT emit `usage` in streaming chunks, so non-stream JSON `usage` is only one source.
  Added `createTaskTimingParser()` — captures llama's own per-task `slot print_timing` numbers
  from stderr (`prompt eval time / N tokens`, `eval time / M tokens`, `total time / T tokens`),
  exposed as `subscribeTaskTiming()`. Tracker merges timing into the in-flight request
  (`applyTaskTiming`); response `usage` wins when both present. Timing can land after the record
  completes (race vs `res "finish"`), so `applyTaskTiming` also back-fills the newest
  completed/tokenless record.
- **Tests**: new `test/requests.test.ts` tracking coverage (streaming usage, non-stream usage,
  not-ready error, subscriber lifecycle, client disconnect via real socket destroy, timing merge,
  usage-wins, back-fill); `createTaskTimingParser` unit test; `routes.test.ts` + `v1-proxy.test.ts`
  deps updated. **52/52 vitest pass, `tsc --noEmit` clean.**
- **UI rewrite** (`gateway/public/index.html`): layout fixes (`.row` gap/wrap/min-width,
  overflow-wrap, chips replace raw JSON, header/card wrap), Inference streams table (backfill
  `/api/requests` + WS `request.*`, Viridis-tinted tok/s, "N active" counter, capped 20 rows),
  Playground (multi-turn bubbles, Send/Stop AbortController, streaming `data:` parse incl.
  `reasoning_content`, inference key stored in `localStorage "inferenceKey"`), theme toggle
  (`localStorage "piTheme"`), JetBrains Mono Google-Fonts link + `--mono` var.
- **PRD/README updated** to document the real token-source split (response `usage` vs llama
  `print_timing`).
- Memory: decision addendum + this session file.

## Notable findings

- llama-server b9500 streaming chunks carry **no `usage` field** — verified against a live
  captured SSE body. Use llama's stderr `slot print_timing` accounting instead (numeric only,
  preserves the no-logging/no-content rule).
- Race: llama prints `print_timing` at generation end, which can arrive after the gateway's
  `res "finish"` has already completed the record → needed the back-fill path in `applyTaskTiming`.
- Qwen3 think-mode makes non-stream responses buffer for minutes (~2.4–2.8 tok/s) — streams are
  the usable path for the UI/playground; a 120s-timeout non-stream curl was killed and correctly
  recorded `error: "client disconnected"`.
- `tsx watch` (dev) hot-reloads; source edits take effect without container restart.
- Gateway listens on `8080`; llama on `8000` inside the container (`docker compose port` not
  usable with ports syntax). No local `node_modules` — run checks via
  `docker compose run --rm gateway-test`.
- Wait — after `docker compose restart`, requests made before the model finishes loading record
  `error: "inference not ready"` (observed in live snapshot, correct behavior).

## Open threads

- README section still labelled "Control Center v2 (planned)" and the status checkbox for it is
  unchecked — needs flipping to implemented (after user sign-off; I did not self-promote).
- `GET /api/requests` returns the ring newest-first? (verify ordering matches PRD §6.12 #46;
  tracker emits/pushes oldest→newest — confirm UI renders newest first as specced).
- Streams table row cap is 20; PRD #47 mentions a bounded table — confirm 20 vs a larger cap.
- No stress test yet for concurrent requests or ring wrap at >200 records.