# Model Data (model-as-data convention)

The Qwen GGUF model is **data, not application code**. It is never baked into the Docker image.

- Host path: `/opt/qwen-model`
- Container path: `/models` (bind mount, gateway service only)
- Active file: `current.gguf` (single active model on disk)

## Rules

- Normally exactly one large GGUF exists: `/opt/qwen-model/current.gguf`.
- Downloads/updates stage into `/opt/qwen-model/.download/` and are moved into place only after verification.
- The model survives container recreation. Deleting `/opt/qwen-model` explicitly removes it.
- The engine (`llama-server`) is likewise external: host-provisioned at `/opt/llama`, mounted read-only.

## Updating

- Host: `./scripts/update-model.sh <model-url>`
- Control center: Model page → Download & Update

See `PRD.md` §10 for the full lifecycle.