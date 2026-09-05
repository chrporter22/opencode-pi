#!/usr/bin/env bash
# Swap llama-server to a newer llama.cpp release.
# The working binary is only ever replaced after the new one verifies — both on
# the host AND inside the gateway's runtime image (Dockerfile base:
# node:22-trixie-slim). A release built for a newer glibc than the container
# provides is rejected and falls back to the default pin.
#
# Usage:  sudo ./scripts/update.sh
# Env:    LLAMA_RELEASE       pin a specific llama.cpp tag (default: b9500). Set to
#                             "latest" to resolve the newest stable tag via the
#                             GitHub API (falls back to b9500 if it has no arm64
#                             binary asset).
#         LLAMA_RUNTIME_IMAGE runtime image used to verify the binary (default
#                             node:22-trixie-slim — keep in sync with the
#                             Dockerfile base).
#         LLAMA_DIR           override install root (default /opt/llama, for testing)
set -euo pipefail

LLAMA_DIR="${LLAMA_DIR:-/opt/llama}"
LLAMA_RUNTIME_IMAGE="${LLAMA_RUNTIME_IMAGE:-node:22-trixie-slim}"
DEFAULT_RELEASE="b9500"

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