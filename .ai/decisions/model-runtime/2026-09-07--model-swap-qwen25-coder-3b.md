# Default model swapped to Qwen2.5-Coder-3B-Instruct (official Q4_K_M)

- **Date:** 2026-09-07
- **Decided by:** user (approved the swap plan, then asked to execute)
- **Topic:** model-runtime

## Decision

The default loaded model moves from Qwen3-1.7B Q4_K_M (bartowski imatrix mirror) to
**Qwen2.5-Coder-3B-Instruct Q4_K_M** from the official `Qwen/Qwen2.5-Coder-3B-Instruct-GGUF`
repo (`qwen2.5-coder-3b-instruct-q4_k_m.gguf`, ~2.10 GB, SHA-256
`724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7`, verified against the HF
tree API). The swap is configuration-only and reuses the atomic update mechanism; the model
ID/alias follows `MODEL_NAME` and is now `Qwen2.5-Coder-3B-Instruct`.

## Why

- A 3B coder-instruct model gives substantially better code-generation quality than the
  1.7B general model at an acceptable size (2.10 GB Q4_K_M) for the Pi 5's 15 GB RAM.
- Q4_K_M stays the quant (faster CPU decode than Q8_0, memory-bandwidth-bound).
- The control plane is model-agnostic (model = env, not code), so only `.env`,
  script defaults, docs, UI copy, and test fixtures change — no gateway or image logic.

## Consequence / note

- Unlike the earlier quant-only Q4_K_M swap, the model ID changed, so the laptop opencode
  config (`opencode.json` model id) must be updated to `Qwen2.5-Coder-3B-Instruct`.
- Context default stays 32768 (Qwen2.5-Coder native max; the 32768 default in
  `config.ts` was uncommitted work from the previous session — test fixtures were aligned
  to it here so the suite is green again).

## Supersedes / relates to

- Advances `2026-09-06--model-swap-q4km-target.md` and
  `2026-09-07--model-swap-q4km-confirmed-context-32768.md` (same mechanics, new model
  target). Prior Qwen3-1.7B Q4_K_M `current.gguf` is the `.previous.gguf` rollback copy.