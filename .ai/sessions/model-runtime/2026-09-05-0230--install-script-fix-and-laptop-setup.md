# Install-script URL fix, model alias, laptop setup prep

- **Date:** 2026-09-05 02:30
- **Developer:** opencode
- **Topic:** model-runtime
- **Session files:** 0102 (M2 plan) and 0150 (M2 pipeline build) are the preceding history;
  this session is the follow-up that unblocks the in-field install.

## Request

User: "also fix url issue for install.sh" then "make these last updates and also write to .ai
when done". Goal: get the model serving on LAN so the user can reach the control center UI
(port 8080) and use opencode against Qwen3-1.7B from an Arch laptop.

## What happened earlier (same day)

- `sudo /home/pi5_nvme/opencode-pi/scripts/install.sh` failed:
  `curl: (3) URL rejected: Malformed input to a URL function`.
- Diagnosed two compounding causes:
  1. `gh_latest()` = `curl … | grep -m1 …` — SIGPIPE race makes curl exit 141; with
     `set -o pipefail` the pipeline fails, so `$(gh_latest … || echo "$DEFAULT_RELEASE")`
     **appends** the fallback to captured output → `RELEASE="v0.4.0\nb10447"` → mangled URL.
     Nondeterministic (a sandbox run had passed earlier).
  2. Even resolved cleanly, "latest" == tag `v0.4.0` which publishes **no arm64 asset**
     (confirmed 404 on `llama-v0.4.0-bin-ubuntu-arm64.tar.gz`). Assets still follow
     `llama-b<NNNN>-bin-ubuntu-arm64.tar.gz`.
- Confirmed `b9500` verified working on the Pi 5 (`version: 9500 (3d1998634)`, GNU 14.2.0).

## Decisions confirmed by user

- Default install/replace target becomes a **pinned tag `b9500`** (tested on this Pi), not
  a resolved "latest". `LLAMA_RELEASE=latest` remains an opt-in that probes the asset URL
  with `curl -I` and falls back to `b9500` if the tag has no arm64 asset. (Recorded
  separately in decisions.)
- Gateway passes `--alias Qwen3-1.7B` to llama-server so `GET /v1/models` returns the
  friendly ID instead of the file path — required for the opencode config to reference
  `Qwen3-1.7B`.

## Implementation (all done + verified)

1. `scripts/install.sh` + `scripts/update.sh` rewritten resolution block:
   - release fetched to a temp file, tag extracted + newline-stripped + charset-validated,
     so no SIGPIPE can corrupt the tag; curl exit status is authoritative.
   - default `DEFAULT_RELEASE=b9500` (no GitHub API dependency on the happy path).
   - asset URL probed with `curl -fsSLI` before download; fallback to `b9500` + clear
     stderr warning when a target tag has no arm64 asset.
   - scripts keep stage → `--version` verify → swap (whole bin dir incl. `libllama-server-impl.so`).
2. `gateway/src/modules/llama/supervisor.ts` `buildLlamaArgs()` appends
   `--alias <config.model.name>` when set; test updated.
3. Verification: `bash -n` ok; **42/42 vitest pass**, `tsc --noEmit` clean; sandbox runs of
   both routes green — default pin installs b9500; `LLAMA_RELEASE=latest` resolves v0.4.0,
   detects missing asset, warns, falls back to b9500 (re-run update path).
4. Dev gateway rebuilt + restarted: model present (skips download), `llama` parked in
   `error` awaiting the binary; alias is live.

## Current state / leave-off point for the user

- llm binary still not provisioned on the host (`/opt/llama` empty) — the URL bug is fixed,
  plain `sudo ./scripts/install.sh` now works.
- The laptop wiring was **double-checked** before being written into the README:
  - opencode custom-provider config shape (`npm: "@ai-sdk/openai-compatible"`, `baseURL`,
    `models.<id>.name`, model IDs must match `GET /v1/models`) confirmed against the current
    opencode providers docs.
  - The gateway accepts both `x-api-key` and `Authorization: Bearer` (`gateway/src/auth.ts`
    lines 19–24) — opencode sends `Bearer`, so `options.apiKey = INFERENCE_API_KEY` works.
  - `/v1/models` + `/chat/completions` are pass-throughs to llama-server via the v1 proxy;
    the `--alias Qwen3-1.7B` arg makes the served model ID `Qwen3-1.7B`, matching the
    opencode `models` key.
- **Next user steps** (also in README "Getting started from your laptop"):
  1. `sudo /home/pi5_nvme/opencode-pi/scripts/install.sh`
  2. `docker compose restart gateway-dev`
  3. `curl -s http://127.0.0.1:8080/api/status` → expect `"llama":"ready"`, `"modelLoaded":true`;
     note `hostname -I` IP + `INFERENCE_API_KEY` from `.env`.
  4. Browser → `http://<pi-ip>:8080` → `ADMIN_API_KEY` for the control center.
  5. `~/.config/opencode/opencode.json` on the Arch laptop → `@ai-sdk/openai-compatible`,
     `baseURL http://<pi-ip>:8080/v1`, model `Qwen3-1.7B` (limit context 8192), top-level
     `"model": "opencode-pi/Qwen3-1.7B"`, `chmod 600`.
  6. Sanity check with curl (`/v1/models` id + streamed completion) before running opencode.
- Open threads: live acceptance (streaming SSE, tok/s, `/v1/models` id `Qwen3-1.7B`) once
  the binary is installed; `AUTO_UPDATE_MODEL` still parsed-but-unscheduled (out of scope).