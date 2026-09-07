# Install scripts provision the Q4_K_M model (not just llama-server)

- **Date:** 2026-09-06
- **Decided by:** user
- **Topic:** model-runtime

## Decision

`scripts/install.sh` and `scripts/update.sh` no longer install llama-server only — they
also install the Qwen3-1.7B 4-bit (**Q4_K_M**) model: download → SHA-256 verify →
atomic swap into `$MODEL_DIR/current.gguf`, then rewrite `MODEL_URL` / `MODEL_SHA256` /
`MODEL_QUANT` in `.env` to the 4-bit values so the gateway boots with the fast model.
The previous model is preserved as `$MODEL_DIR/.previous.gguf` for rollback; removing it
is an explicit, guarded step (`--clean-old` on install/update, or
`sudo ./scripts/cleanup.sh --previous-model`), never something the swap does
unconditionally. The clean-up path can never touch the live `current.gguf`.

## Why

- The gateway's own startup download only pulls whatever `.env` names; the user wants
  the install/update scripts themselves to deliver 4-bit for token speed on the Pi.
- Download/verify/atomic-rename mirrors the gateway's `update-model.action` /
  `model-store.ts` pattern, so behavior is consistent across both paths.
- The preserved `.previous.gguf` keeps the swap reversible (no re-download needed for
  rollback), and making cleanup explicit honors the repo rule to never delete a working
  model without a deliberate, user-facing action.
- The host `.env` is gitignored, so the scripts rewrite the real config in place; the
  gateway only reloads it after `docker compose up -d` (recreate, not restart).

## Supersedes / relates to

- Builds on `2026-09-06--model-swap-q4km-target.md` (Q8_0 → Q4_K_M target + runbook) —
  this adds the script path so the swap no longer requires manual `.env` editing.
- Relates to `2026-09-05--model-choice-and-base-image.md` (original Q8_0 default).