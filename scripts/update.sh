#!/usr/bin/env bash
# Swap llama-server to a newer llama.cpp release AND (re)install the 4-bit
# Qwen3-1.7B model.
# The working binary is only ever replaced after the new one verifies — both on
# the host AND inside the gateway's runtime image (Dockerfile base:
# node:22-trixie-slim). A release built for a newer glibc than the container
# provides is rejected and falls back to the default pin.
#
# The model GGUF is downloaded only when the target quant is not already in place.
# It is SHA-256 verified before an atomic swap (live file only replaced by a
# verified file), and .env is updated to the 4-bit values.
#
# Usage:  sudo ./scripts/update.sh [--clean-old]
#   --clean-old   remove the previous model rollback copy (.previous.gguf) after
#                 the new model is verified in place.
#
# Env:    LLAMA_RELEASE       pin a specific llama.cpp tag (default: b9500). Set to
#                             "latest" to resolve the newest stable tag via the
#                             GitHub API (falls back to b9500 if it has no arm64
#                             binary asset).
#         LLAMA_RUNTIME_IMAGE runtime image used to verify the binary (default
#                             node:22-trixie-slim — keep in sync with the
#                             Dockerfile base).
#         LLAMA_DIR           override install root (default /opt/llama, for testing)
#         MODEL_DIR           override model dir (default /opt/qwen-model, for testing)
#         MODEL_URL           model file URL (default: Qwen3-1.7B Q4_K_M imatrix)
#         MODEL_SHA256        expected SHA-256 of the model file (must match URL)
#         MODEL_QUANT         quantization label written to .env (default Q4_K_M)
#         MODEL_FILE          model filename (default current.gguf)
#         ENV_FILE            .env path to update (default: <this repo>/.env)
set -euo pipefail

LLAMA_DIR="${LLAMA_DIR:-/opt/llama}"
MODEL_DIR="${MODEL_DIR:-/opt/qwen-model}"
LLAMA_RUNTIME_IMAGE="${LLAMA_RUNTIME_IMAGE:-node:22-trixie-slim}"
DEFAULT_RELEASE="b9500"
MODEL_URL="${MODEL_URL:-https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf}"
MODEL_SHA256="${MODEL_SHA256:-72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb}"
MODEL_QUANT="${MODEL_QUANT:-Q4_K_M}"
MODEL_FILE="${MODEL_FILE:-current.gguf}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env}"
CLEAN_OLD=0
for arg in "$@"; do
  case "$arg" in
    --clean-old) CLEAN_OLD=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown option: $arg" >&2; exit 1 ;;
  esac
done

latest_release() {
  local tmp tag
  tmp="$(mktemp)"
  if curl -fsSL "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -o "$tmp" 2>/dev/null; then
    tag="$(grep -o '"tag_name"[^,]*' "$tmp" | head -n1 | sed -E 's/.*"([^"]+)".*/\1/')"
    tag="${tag%%$'\r'*}"
    tag="${tag%%$'\n'*}"
    rm -f "$tmp"
    if printf '%s' "$tag" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._+-]*$'; then
      printf '%s' "$tag"
      return 0
    fi
    return 1
  fi
  rm -f "$tmp"
  return 1
}

asset_url() {
  printf 'https://github.com/ggml-org/llama.cpp/releases/download/%s/llama-%s-bin-ubuntu-arm64.tar.gz' "$1" "$1"
}

# Verify a staged llama-server both on the host and — when docker is available —
# inside the gateway's runtime image. The container check is authoritative: the
# gateway spawns llama-server inside that container, so glibc/lib mismatches that
# would pass on the host must be caught here. libgomp1 mirrors the apt install in
# the Dockerfiles, so LLAMA_RUNTIME_IMAGE + libgomp1 == the real llama runtime.
runtime_check() {
  local dir="$1"
  if ! "$dir/llama-server" --version >/dev/null 2>&1; then
    echo "ERROR: downloaded binary did not run on this host" >&2
    return 1
  fi
  if ! docker run --rm --pull=missing -v "$dir:/check:ro" "$LLAMA_RUNTIME_IMAGE" \
      sh -c 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq --no-install-recommends libgomp1 >/dev/null 2>&1; ldd /check/llama-server 2>&1 | grep -q "not found" && exit 1; /check/llama-server --version >/dev/null' 2>/dev/null; then
    echo "ERROR: binary is not compatible with the gateway runtime image (${LLAMA_RUNTIME_IMAGE})" >&2
    echo "      it is built for a newer glibc/lib set than the container provides." >&2
    return 1
  fi
  return 0
}

stage_and_swap() {
  local release="$1"
  local url asset tmp bin bin_dir stage_dir
  url="$(asset_url "$release")"
  asset="llama-${release}-bin-ubuntu-arm64.tar.gz"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  echo "Downloading ${asset}..."
  if ! curl -fSL "$url" -o "$tmp/llama.tar.gz" 2>/dev/null; then
    echo "ERROR: download failed: ${url}" >&2
    return 1
  fi
  tar -xzf "$tmp/llama.tar.gz" -C "$tmp"
  bin="$(find "$tmp" -type f -name llama-server | head -n1)"
  if [ -z "$bin" ]; then
    echo "ERROR: llama-server not found in archive" >&2
    return 1
  fi
  bin_dir="$(dirname "$bin")"

  stage_dir="$LLAMA_DIR/.llama.$$"
  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  cp -a "$bin_dir/." "$stage_dir/"
  if runtime_check "$stage_dir"; then
    cp -a "$stage_dir/." "$LLAMA_DIR/"
    rm -rf "$stage_dir"
    return 0
  fi
  rm -rf "$stage_dir"
  return 1
}

# Install the model GGUF into $MODEL_DIR/$MODEL_FILE.
# - Skips download if the file already exists AND its SHA-256 matches the target.
# - Downloads to a staging path, verifies SHA-256, then atomically renames into
#   place. The live file is never replaced by an unverified file.
# - A previous model (e.g. old Q8_0) is preserved at $MODEL_DIR/.previous.gguf as
#   a rollback copy unless --clean-old is given, which deletes it.
# - Returns non-zero on any failure WITHOUT touching an existing verified model.
provision_model() {
  local target tmp had_previous
  target="$MODEL_DIR/$MODEL_FILE"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  if [ -f "$target" ]; then
    local current_sha
    current_sha="$(sha256sum "$target" | awk '{print $1}')"
    if [ "$current_sha" = "$MODEL_SHA256" ]; then
      echo "Model already installed and verified ($MODEL_QUANT); skipping download"
      return 0
    fi
    echo "Model present but not the target ($MODEL_QUANT); replacing"
  fi

  echo "Downloading model $MODEL_QUANT: $MODEL_URL"
  if ! curl -fsSL "$MODEL_URL" -o "$tmp/source.gguf"; then
    echo "ERROR: model download failed: $MODEL_URL" >&2
    return 1
  fi
  if [ "$(sha256sum "$tmp/source.gguf" | awk '{print $1}')" != "$MODEL_SHA256" ]; then
    echo "ERROR: model SHA-256 mismatch; not touching the installed model" >&2
    return 1
  fi
  echo "Model SHA-256 verified"

  if [ -f "$target" ]; then
    had_previous=1
    mkdir -p "$MODEL_DIR"
    cp -a "$target" "$MODEL_DIR/.previous.gguf"
    echo "Previous model preserved at $MODEL_DIR/.previous.gguf"
  fi

  if mv -f "$tmp/source.gguf" "$target"; then
    echo "Installed model $MODEL_QUANT at $target ($(du -h "$target" | cut -f1))"
    if [ "$CLEAN_OLD" = "1" ] && [ "${had_previous:-0}" = "1" ]; then
      rm -f "$MODEL_DIR/.previous.gguf"
      echo "--clean-old: removed previous model $MODEL_DIR/.previous.gguf"
    fi
    return 0
  fi
  echo "ERROR: failed to install model at $target" >&2
  return 1
}

# Point .env at the installed 4-bit model so the gateway boots with it.
# Rewrites MODEL_URL / MODEL_SHA256 / MODEL_QUANT; other values are untouched.
set_env_model() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "WARNING: no .env at $ENV_FILE; not updating gateway config" >&2
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  sed -E \
    -e "s|^(MODEL_URL=).*|\1$MODEL_URL|" \
    -e "s|^(MODEL_SHA256=).*|\1$MODEL_SHA256|" \
    -e "s|^(MODEL_QUANT=).*|\1$MODEL_QUANT|" \
    "$ENV_FILE" > "$tmp" || return 1
  if grep -q "^MODEL_URL=" "$ENV_FILE"; then
    cp -a "$tmp" "$ENV_FILE"
  else
    printf '\nMODEL_URL=%s\nMODEL_SHA256=%s\nMODEL_QUANT=%s\n' \
      "$MODEL_URL" "$MODEL_SHA256" "$MODEL_QUANT" >> "$ENV_FILE"
  fi
  echo "Updated $ENV_FILE: MODEL_URL/MODEL_SHA256/MODEL_QUANT -> $MODEL_QUANT"
}

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) ;;
  *) echo "ERROR: unsupported architecture: $ARCH (expect aarch64)" >&2; exit 1 ;;
esac

RELEASE=""
if [ -n "${LLAMA_RELEASE:-}" ]; then
  if [ "$LLAMA_RELEASE" = "latest" ]; then
    if RELEASE="$(latest_release)"; then
      echo "llama.cpp latest release: ${RELEASE}"
    else
      echo "WARNING: could not resolve latest release; using pin ${DEFAULT_RELEASE}" >&2
      RELEASE="$DEFAULT_RELEASE"
    fi
  else
    RELEASE="$LLAMA_RELEASE"
  fi
else
  RELEASE="$DEFAULT_RELEASE"
fi

if ! printf '%s' "$RELEASE" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._+-]*$'; then
  echo "WARNING: invalid release tag '${RELEASE}'; using pin ${DEFAULT_RELEASE}" >&2
  RELEASE="$DEFAULT_RELEASE"
fi
echo "llama.cpp release: ${RELEASE}"

mkdir -p "$LLAMA_DIR"

if ! stage_and_swap "$RELEASE"; then
  if [ "$RELEASE" != "$DEFAULT_RELEASE" ]; then
    echo "WARNING: release ${RELEASE} failed verification; falling back to pin ${DEFAULT_RELEASE}" >&2
    RELEASE="$DEFAULT_RELEASE"
    if ! stage_and_swap "$RELEASE"; then
      echo "ERROR: default release ${DEFAULT_RELEASE} failed verification too;" >&2
      echo "      current install left untouched" >&2
      exit 1
    fi
  else
    echo "ERROR: default release ${DEFAULT_RELEASE} failed verification;" >&2
    echo "      current install left untouched" >&2
    exit 1
  fi
fi

echo "Updated: $("$LLAMA_DIR/llama-server" --version 2>&1 | head -n1)"

echo "--- Model ---"
if ! provision_model; then
  echo "ERROR: model install failed; llama-server updated but model untouched" >&2
  exit 1
fi
set_env_model
echo "update complete"