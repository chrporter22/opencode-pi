# M2 model choice and container base change

- **Date:** 2026-09-05
- **Decided by:** user
- **Topic:** model-runtime

## Decision

1. The target model is **Qwen3-1.7B, Q8_0** (`Qwen/Qwen3-1.7B-GGUF`, Apache-2.0, 1.83 GB),
   chosen for the user's 8–10 tokens/s target on the Raspberry Pi 5 — 8B-class models measured
   ~1.6–2.4 tok/s (Q4) on this board, far below target, and Q8_0 at 8B needs 9.5–10 GB RAM.
2. The gateway container base image switches from `node:22-alpine` to **`node:22-bookworm-slim`**
   so the official glibc Ubuntu-arm64 `llama-server` binary can run inside the container.
3. The model display name becomes `Qwen3-1.7B` (superseding the `qwen3.5` placeholder everywhere).
4. The llama.cpp runtime is pinned to the **latest stable release** at implementation time.

## Why

- The 8–10 tok/s target plus a 16 GB Pi 5 maps to the ~1.7B Q8_0 tier: ~8.7 tok/s at ~1.2 GB
  RAM is measured on the same cortex-A76 class. Higher-intelligence 8B runs at ~2 tok/s ("batch,
  not chat"), which contradicts the conversational goal ("Basic chat" in PRD §23).
- The official llama.cpp aarch64 binaries are glibc-linked; Alpine (musl) cannot execute them.
  Bookworm-slim keeps the image small while letting us use glue-free official binaries and keep
  the single-container topology (llama supervised inside the gateway).

## Supersedes / relates to

- Supersedes the `qwen3.5` model name placeholder from PRD/README (project-init decisions).
- Builds on `2026-09-05--build-phasing-and-framework-choices.md` (M2 scope).