# Session: context capped to 8192 + Qwen3 reasoning-latency diagnosis

Date: 2026-09-07 (slot 1240)

## Context
User reported: "not getting response back from llama to opencode from arch laptop, i see the stream started." Investigation traced it to resource contention + Qwen3-1.7B's reasoning-model behavior. User chose to cap context lower (`LLAMA_CONTEXT_SIZE=8192`).

## Diagnosis (root cause)
- The Pi was running **two opencode instances**: the laptop's AND a Pi-local one (`~/.config/opencode/opencode.jsonc`, PID 1698686). Both pointed at the gateway, both advertising/using a 32768 context.
- llama-server pegged at 248% CPU (all 4 cores, 5.6GB RES) evaluating the growing multi-turn prompts the Pi-local agent kept sending (2048 → 4096+ prompt tokens at ~24 t/s prompt-eval). Load average ~5.8. The laptop's request queued behind it → "stream started, no response."
- With only one client active, non-stream replies returned in ~2s and the first streaming `reasoning_content` chunk in ~800ms. Proxy/broadcast were NOT faulty.
- Second factor: **Qwen3-1.7B is a reasoning model** — it streams `reasoning_content` for ~15-45s before emitting any `content` delta. opencode's OpenAI-compatible provider renders `content`, so a correct stream can look like "started but empty" until thinking completes. If `max_tokens` ends during thinking, `content` is empty entirely.

## Change applied: cap context to 8192
- `.env`: `LLAMA_CONTEXT_SIZE=32768` → `8192` (this is baked at compose build/up, requires rebuild).
- Code default kept consistent with runtime: `gateway/src/config.ts` `.default(8192)`.
- Fixtures/tests: `gateway/test/config.test.ts` default expectation 32768→8192; `gateway/test/routes.test.ts` `contextSize: 8192`.
- Docs: README table `8192`, README opencode-config example `context: 8192`, README §5 note, PRD table + expected-context-length section.
- Pi-local opencode config: `~/.config/opencode/opencode.jsonc` `"context": 8192` (must match the gateway's advertised/served context; the laptop config should be updated the same way — it was originally mismatched 38912 output too).
- Rebuilt: `docker compose up -d --build gateway-dev`. Verified spawn line `--ctx-size 8192 --alias Qwen3-1.7B --threads 4`. typecheck clean, 63/63 tests.

## Verified behavior after change
- Single-client latency: first `reasoning_content` ~1.1s (was ~46s under contention), first `content` ~25s on a tiny prompt (inherent Qwen3 thinking, not context-bound).
- Benefit of 8192: prompt-eval time and KV-cache/RAM are bounded, so large multi-turn prompts can no longer saturate the whole Pi and starve other clients.

## Notes / next
- The "no response" feel will return if two opencode agents run concurrently at once; architecture supports only one primary consumer in practice. Consider documenting a single-client expectation.
- Qwen3 reasoning delay (15-45s before `content`) is inherent; if the user wants snappier visible output, options: a system prompt telling Qwen3 to answer directly (skip long reasoning), or `max_tokens` headroom, or a non-reasoning model.
- Laptop opencode config still needs its baseURL corrected + context set to 8192 to match; not edited here (do it on the laptop).