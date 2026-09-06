# Model swap plan: Q8_0 → Q4_K_M (4-bit) in PRD + README

- **Date:** 2026-09-06 19:00
- **Developer:** opencode
- **Topic:** model-runtime
- **Preceding:** 1813 (analytics-layer docs refresh). Same docs-only session; no code changed.

## Request

"make a plan in prd and readme for swapping to 3.5-1.7b in 4 bit step by step; write
.ai sessions too". Read as: plan a step-by-step swap of the loaded model from Q8_0 to
the 4-bit Q4_K_M quant of Qwen3-1.7B. There is no public "Qwen3.5-1.7B" artifact; the
web + HF repo search resolved "3.5-1.7b" as a typo for Qwen3-1.7B in 4-bit (recorded as
an assumption, not user-confirmed as such).

## What was done

- **Artifact research.** The official `Qwen/Qwen3-1.7B-GGUF` repo ships Q8_0 only; the
  imatrix `Q4_K_M` quant lives in `bartowski/Qwen_Qwen3-1.7B-GGUF`. Pulled the exact
  metadata from the HF tree API: URL, size 1,282,439,584 B (~1.28 GB), SHA-256
  `72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb`.
- **Verified the real update mechanism from code**, so the written plan matches actual
  behavior (not PRD prose):
  - Model is fully env/config-driven: `gateway/src/config.ts` (MODEL_URL, MODEL_SHA256,
    MODEL_QUANT, MODEL_NAME, MODEL_FILE, MODEL_DIR).
  - `POST /api/model/update` takes **no body** — URL/SHA come from config
    (`gateway/src/routes/control.ts:125`, via `updateModelAction`).
  - Flow: download → `.download/source.gguf` → SHA-256 verify
    (`model-store.ts:46 installModelFromFile`) → copy to `.download/.current.gguf.tmp` →
    atomic `rename` → `/models/current.gguf` → cleanup → `llama.restart()`.
  - Admin auth = `x-api-key` or `Authorization: Bearer` (`auth.ts`).
  - Env changes require `docker compose up -d` (recreate) — `restart` keeps the old env.
- **PRD:** added §10.7 ("Step-by-step: swap the default model to a 4-bit quant
  (Q8_0 → Q4_K_M)") + a swap-target bullet in §23 recording the Q4_K_M plan and the
  "3.5" typo resolution.
- **README:** added "### 7. Swap the model to Q4_K_M (4-bit)" with the 7 steps,
  rollback, and a note that the laptop opencode config keeps working (model ID
  unchanged).

## Notable findings

- **Doc inaccuracy found:** PRD §10.2–10.4 reference `scripts/ensure-model.sh` and
  `scripts/update-model.sh`, but `scripts/` only contains `install.sh`, `update.sh`,
  `cleanup.sh` (llama runtime only). The real paths are the in-container
  `ensure-model.action` / `update-model.action` + the gateway API. The plan documents
  the real path and flags the mismatch; the docs are not reworked in this session.
- bartowski's Q4_K_M is an **imatrix** quant — better quality at the same 4-bit size
  than a plain Q4_K_M; a sensible default for CPU 4-bit.
- Decode is memory-bandwidth-bound: 1.28 GB vs 1.83 GB → expect ~1.3–1.6× tok/s; real
  numbers still need measurement on the Pi.
- Model alias/id and the `/opt/qwen-model` mount are unchanged across the swap → no
  client-side effect.

## Open threads

- The plan is documentation only; the actual swap on the Pi is a user action (or a
  follow-up session if the user wants it driven from here, incl. running the update and
  measuring tok/s).
- PRD §10 script references (`ensure-model.sh` / `update-model.sh`) mismatch the repo —
  decide whether to fix the docs or add the host scripts.
- Working tree still uncommitted (analytics docs refresh + this session).