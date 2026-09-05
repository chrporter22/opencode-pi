#!/usr/bin/env bash
# Remove known temporary artifacts only. Never touches the working model
# (/opt/qwen-model/current.gguf) or the installed llama-server binary.
#
# Usage:  sudo ./scripts/cleanup.sh
set -euo pipefail

clean_staging() {
  local dir="$1"
  if [ -d "$dir" ]; then
    echo "removing staging dir: $dir"
    rm -rf "$dir"
  fi
}

clean_staging /opt/qwen-model/.download
clean_staging /opt/llama/.download

for f in /opt/qwen-model/.current.gguf.*.tmp; do
  if [ -e "$f" ]; then
    echo "removing stale staging file: $f"
    rm -f "$f"
  fi
done

echo "cleanup complete (working model and installed binary untouched)"