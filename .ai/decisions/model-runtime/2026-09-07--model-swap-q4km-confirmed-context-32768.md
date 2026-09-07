# Qwen3-1.7B 4-bit switch confirmed + context default 32768

- **Date:** 2026-09-07
- **Decided by:** user
- **Topic:** model-runtime

## Decision

- User confirmed the move to 4-bit inference: Qwen3-1.7B **Q4_K_M** from the
  `bartowski/Qwen_Qwen3-1.7B-GGUF` community mirror (only source of 4-bit quants —
  verified via the HF API that the official `Qwen/Qwen3-1.7B-GGUF` repo ships **only
  `Q8_0`**, which is why no 4-bit is available "directly from Qwen").
- Verified against HF LFS: `Qwen_Qwen3-1.7B-Q4_K_M.gguf` (1,282,439,584 B) blob SHA-256
  `72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb` — matches the
  default pinned in `scripts/install.sh` / `scripts/update.sh`. No hash changes needed.
- Context raised to the Qwen3-1.7B maximum: `LLAMA_CONTEXT_SIZE` default `8192 →
  32768` (repo `.env` was already `32768`).
- Code/docs updated so 4-bit + 32k is now the default target: `gateway/src/config.ts`
  default, README §5 opencode config + §7, PRD §10.7, and the config test fixture.

## Why

- CPU decode is memory-bandwidth-bound; Q4_K_M (~1.28 GB) is meaningfully faster than
  Q8_0 (~1.83 GB) at acceptable local quality, and 32768 tokens is the model's native
  max (KV cache ≈ 1.8 GB f16 at full 32k — fine on the 15 GB Pi 5).

## Status

- Defaults/config history updated. The live host swap (download 1.28 GB, atomic replace,
  `.env` update) is done via `sudo ./scripts/install.sh --clean-old` + a gateway restart
  and was still pending user execution at the time of writing.

## Supersedes / relates to

- Advances `2026-09-06--model-swap-q4km-target.md` (kept Q8_0 default "until executed").