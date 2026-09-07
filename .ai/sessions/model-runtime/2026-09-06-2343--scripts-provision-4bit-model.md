# install/update scripts: provision Qwen3-1.7B 4-bit model + cleanup

- **Date:** 2026-09-06 23:43
- **Developer:** opencode (big-pickle)
- **Topic:** model-runtime / scripts
- **Preceding:** model-swap plan 1900 + decision `2026-09-06--model-swap-q4km-target.md`

## Request

"update so install script installs qwen3-1.7b 4 bit for token speed give user plan for
update new model download and runtime and clean up old model".

Clarified with user:
- install.sh should **download the model itself** (SHA-256 verify + atomic swap into
  `MODEL_DIR/current.gguf`) and set `.env` to the Q4_K_M values, not just rely on the
  gateway's startup download.
- old Q8_0 model cleanup should be an **explicit guarded step/flag**, not just the
  atomic-rename fallback.

## What was done

- **`scripts/install.sh`** — became the single provisioning path for both llama-server
  and the model:
  - New env overrides: `MODEL_URL`, `MODEL_SHA256`, `MODEL_QUANT` (default `Q4_K_M`),
    `MODEL_FILE`, `ENV_FILE` (default `<repo>/.env`); `LLAMA_DIR`/`MODEL_DIR` already
    existed.
  - Option parsing: `--clean-old`, `-h|--help` (prints the header via `grep '^#'`).
  - `provision_model()`: skips if `current.gguf` SHA-256 already matches; downloads to a
    `mktemp -d` staging dir, SHA-256 verifies, preserves the old model as
    `$MODEL_DIR/.previous.gguf` (rollback copy), atomic `mv -f` into
    `$MODEL_DIR/current.gguf`; `trap 'rm -rf "$tmp"' RETURN`; `--clean-old` deletes the
    preserved copy. Returns non-zero on failure WITHOUT touching an existing verified
    model.
  - `set_env_model()`: sed-rewrites `MODEL_URL`/`MODEL_SHA256`/`MODEL_QUANT` in `.env`
    (append if missing; warns if no `.env`), so the gateway boots with 4-bit config.
- **`scripts/update.sh`** — mirrored the same header/options/`provision_model`/
  `set_env_model`, wired after the llama stage swap. (An edit hiccup that dropped the
  `ARCH="$(uname -m)"` line was caught and restored.)
- **`scripts/cleanup.sh`** — added `MODEL_DIR`/`LLAMA_DIR` overrides and a
  `--previous-model` flag that removes `$MODEL_DIR/.previous.gguf` (name chosen so it
  can never touch the live `current.gguf`).
- **Docs** — README §7 now leads with the script path (with runtime verification steps)
  and PRD §10.7a/§10.7b split: host-script swap (recommended) vs. gateway API steps,
  cleanup via `--clean-old` / `cleanup.sh --previous-model`, rollback via the preserved
  copy. PRD notes updated (scripts no longer "don't exist").

## Verification

- `bash -n` clean on all three scripts.
- Sandbox (eval'd functions) tests passed: happy-path replace Q8_0→Q4 preserves
  `.previous.gguf` + rewrites `.env`; re-provision skips on matching SHA; `CLEAN_OLD=1`
  removes the preserved copy; missing-env warning; SHA-mismatch rejection leaves the
  installed model untouched (re-confirmed with a fake-curl mis-checksum run).
- NOT run: full real `install.sh` on the Pi (needs sudo + ~1.28 GB download + docker
  runtime-check).

## Notable findings

- `scripts/install.sh` / `update.sh` previously provisioned **llama-server only**; the
  model `current.gguf` was downloaded by the gateway at startup from `MODEL_URL` /
  `MODEL_SHA256` env (`.env`). `.env` currently points at Qwen3-1.7B **Q8_0**.
- Q4_K_M target (documented in README §7 / PRD §10.7): bartowski imatrix mirror,
  `Qwen_Qwen3-1.7B-Q4_K_M.gguf`, ~1.28 GB, SHA-256
  `72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb`.
- model-store.ts / update-model.action already implement the download → verify → copy →
  atomic rename → cleanup pattern the scripts will mirror.

## Open threads

- Full real run of `install.sh`/`update.sh` on the Pi not yet executed (needs sudo).
- `.env` on the host still points at Q8_0 until the user runs the script (or the API
  path). Work uncommitted.
