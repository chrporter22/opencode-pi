# Docs integrated from original product spec

- **Date:** 2026-09-04
- **Decided by:** user
- **Topic:** project-init

## Decision

The original product spec (§1–40) is fully integrated into `PRD.md` v0.2 and `README.md`, superseding gaps in the first pass. Key resolutions:

1. **Model and llama runtime are both external to the image.** The GGUF lives on the host at `/opt/qwen-model` (mounted `/models`); the `llama-server` binary lives on the host at `/opt/llama` (mounted `:ro`). The Docker image is the Node gateway only — small, independent of model size. This supersedes the original "gateway + llama in one image" idea while preserving the single-container topology.
2. **Two-key auth supersedes the single `GATEWAY_API_KEY`.** The early single key now maps to the inference key; the admin key is the additional stronger credential for the control surface.
3. **Model updates have two entry points, one mechanism.** Host `scripts/update-model.sh` and the gateway admin route `POST /api/model/update` both use the atomic staging/verify/swap/reload pipeline.
4. **Manual updates initially; auto-update is opt-in.** `AUTO_UPDATE_MODEL=false` default, `AUTO_UPDATE_INTERVAL=24h` reserved for later.
5. **Control-center items moved from "future" to v1.** Web control center, dashboard, CPU/RAM/temperature/tok-s monitoring, and request metrics are now in initial scope (PRD §9, §6.11).

## Why

- The original spec's operational guarantees (atomicity, one model on disk, no build-time downloads, readiness gating, clean shutdown) are hard requirements worth stating explicitly in the PRD before code is written.
- Keeping the image free of both the model and the llama runtime makes it trivial to update the runtime and to keep image/build cheap on the Pi.
- Requirements 41/42 keep their numbers exactly as the user added them; the core list was restructured to fit exactly 40.

## Supersedes / relates to

- Relates to `2026-09-04--project-init-decisions.md` (naming, docs-first, single-file UI, gateway reverse proxy).