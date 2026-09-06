# Model swap target: Qwen3-1.7B Q4_K_M (bartowski imatrix)

- **Date:** 2026-09-06
- **Decided by:** user
- **Topic:** model-runtime

## Decision

The Pi may move its loaded model from Qwen3-1.7B Q8_0 to the 4-bit **Q4_K_M** quant for
faster local inference, with no code change. The official Qwen repo ships Q8_0 only, so
the 4-bit file is taken from the community imatrix mirror
`bartowski/Qwen_Qwen3-1.7B-GGUF` (`Qwen_Qwen3-1.7B-Q4_K_M.gguf`, ~1.28 GB, SHA-256
`72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb`). The swap is a
`.env` change (MODEL_URL / MODEL_SHA256 / MODEL_QUANT) plus the standard atomic
`POST /api/model/update`; rollback = restore `.env` + re-run the update. The runbook is
documented in PRD §10.7 and README §7. The default stays Q8_0 until the swap is actually
executed.

Note: "3.5-1.7b" was resolved here as Qwen3-1.7B in 4-bit — no public "Qwen3.5-1.7B"
GGUF exists. The specific quant choice (Q4_K_M as the CPU 4-bit default) is documented
in the plan with Q5_K_M as the next step up.

## Why

- CPU decoding is memory-bandwidth-bound; Q4_K_M is ~1.28 GB vs ~1.83 GB for Q8_0, so a
  meaningful throughput gain (~1.3–1.6× expected) with acceptable local quality.
- Q4_K_M with imatrix is the standard quality/speed default for CPU 4-bit inference.
- The control plane is quant-agnostic (model is config, not code), so the swap is cheap
  and fully reversible without touching `/opt/llama`, the image, or client configs
  (the model ID/alias stays `Qwen3-1.7B`).

## Supersedes / relates to

- Relates to `2026-09-05--model-choice-and-base-image.md` (original Q8_0 choice and
  official source repo) — this adds an optional swap target, not a replacement of the
  default.