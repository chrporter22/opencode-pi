#!/usr/bin/env bash
# Remove known temporary artifacts only. Never touches the working model
# (/opt/qwen-model/current.gguf) or the installed llama-server binary.
#
# Usage:  sudo ./scripts/cleanup.sh [--previous-model]
#   --previous-model  also remove the rollback copy of the previous model
#                     ($MODEL_DIR/.previous.gguf, kept by scripts/install.sh
#                     unless --clean-old was used). Safe: never the live model.
set -euo pipefail

MODEL_DIR="${MODEL_DIR:-/opt/qwen-model}"
LLAMA_DIR="${LLAMA_DIR:-/opt/llama}"

REMOVE_PREVIOUS=0
for arg in "$@"; do
  case "$arg" in
    --previous-model) REMOVE_PREVIOUS=1 ;;
    *) echo "ERROR: unknown option: $arg" >&2; exit 1 ;;
  esac
done

clean_staging() {
  local dir="$1"
  if [ -d "$dir" ]; then
    echo "removing staging dir: $dir"
    rm -rf "$dir"
  fi
}

clean_staging "$MODEL_DIR/.download"
clean_staging "$LLAMA_DIR/.download"

for f in "$MODEL_DIR"/.current.gguf.*.tmp; do
  if [ -e "$f" ]; then
    echo "removing stale staging file: $f"
    rm -f "$f"
  fi
done

if [ "$REMOVE_PREVIOUS" = "1" ] && [ -e "$MODEL_DIR/.previous.gguf" ]; then
  echo "removing previous-model rollback copy: $MODEL_DIR/.previous.gguf"
  rm -f "$MODEL_DIR/.previous.gguf"
fi

echo "cleanup complete (working model and installed binary untouched)"