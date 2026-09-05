# Install scripts pin a tested release; model served under a friendly alias

- **Date:** 2026-09-05
- **Developer:** opencode
- **Topic:** model-runtime
- **Stakeholder:** user (confirmed ahead of the fix)

## Why

The original `install.sh`/`update.sh` resolved "latest" from the GitHub API. That broke in
the field:

1. The resolver piped `curl … | grep -m1 …` inside `$(…)  || echo $DEFAULT`; the SIGPIPE
   race made the pipeline exit 141 under `pipefail`, and the fallback got **appended** to
   the captured tag (`v0.4.0\nb10447`), producing a malformed download URL.
2. Following llama.cpp's new semver tagging, the then-latest tag `v0.4.0` publishes no
   arm64 binary asset at all — earlier builds follow `llama-b<NNNN>-bin-ubuntu-arm64.tar.gz`.

## Decision

- **Host scripts default to a pinned, Pi-tested release (`b9500`)** instead of resolving a
  "latest" tag. No GitHub API dependency on the happy path.
- `LLAMA_RELEASE=latest` remains an explicit opt-in; before downloading it probes the asset
  URL (`curl -I`) and falls back to `b9500` with a clear warning when the tag lacks an arm64
  asset.
- New releases require a deliberate pin to a build that is actually published for arm64 and
  smoke-tested on the Pi.
- The gateway passes `--alias <MODEL_NAME>` to llama-server (default `Qwen3-1.7B`) so the
  served model ID is stable and user-friendly for client configs (e.g. opencode), instead of
  the raw model file path.

## Impact

- `scripts/install.sh`, `scripts/update.sh` (same resolution block, duplicated per codebase
  convention for <3 call sites).
- `gateway/src/modules/llama/supervisor.ts` builds `--alias` from config.

## Alternatives considered

- Semver "latest" + asset probe with a new naming scheme — the `-bin-` name pattern is not
  published for semver tags, so this buys nothing until llama.cpp revives arm64 assets for
  semver releases.
- Present-model-ID as config in the gateway's `/v1/models` response only — divergent from the
  upstream llama-server ID the proxy passes through; a gateway-side alias would be a lie.