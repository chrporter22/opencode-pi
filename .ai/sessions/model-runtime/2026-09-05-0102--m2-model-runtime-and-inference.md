# M2 model runtime and inference

- **Date:** 2026-09-05 01:02
- **Developer:** opencode
- **Topic:** model-runtime

## Request

M2: turn the gateway into a working inference endpoint — llama-server supervised inside the
container, real `/v1/*` proxy with streaming, host scripts (install/update/cleanup), real
model lifecycle endpoints — using the verified Qwen3-1.7B Q8_0 model on the 16 GB Pi 5.

## Plan approved (user, 2026-09-05)

1. Base image swaps `node:22-alpine` → `node:22-bookworm-slim` (glibc so the official
   Ubuntu-arm64 llama binary can run in-container). User confirmed.
2. `MODEL_NAME` display updated from the `qwen3.5` placeholder. User confirmed.
3. llama.cpp release: latest stable at implementation time. User confirmed.
4. Model: `Qwen/Qwen3-1.7B-GGUF` `Qwen3-1.7B-Q8_0.gguf` 1.83 GB,
   sha256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`,
   expected ~8.7 tok/s, ~1.2 GB RAM on Pi 5 (16 GB).
5. Runtime binary: `llama-b<NNNN>N-bin-ubuntu-arm64.tar.gz` from ggml-org/llama.cpp releases.

Subtasks M2.1–M2.8 (base image; config/env; scripts; atomic pipeline; supervisor; /v1 proxy;
lifecycle endpoints; acceptance + memory). Filled in as they complete.

## Open threads

- (this session's threads append here)