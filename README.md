# opencode-pi

A self-hosted, LAN-only local AI control center for a Raspberry Pi 5. Runs a quantized Qwen3-1.7B (Q8_0) GGUF model through llama.cpp's `llama-server`, exposes an OpenAI-compatible inference API to OpenCode (and any OpenAI-compatible client) on your local network, and ships a clean, single-file browser control center for monitoring and operating the system.

## What it does

- **Runs Qwen3-1.7B locally** on a Raspberry Pi 5 (Q8_0 quant).
- **Exposes one OpenAI-compatible endpoint** to OpenCode over the LAN: `http://<pi-ip>:8080/v1`.
- **Keeps the model out of the image.** The GGUF and the `llama-server` binary are both external — mounted in, never baked in.
- **Provisions the model automatically.** On first start, if `current.gguf` is missing it is downloaded, verified, and atomically installed.
- **Manages the model safely.** Single active model on disk, atomic swaps, no accumulation of old GGUFs, updates via script or the control center.
- **Serves a control center** for status, metrics, live logs, model management, and a test chat interface.

## Architecture

```
LAN ──► Express Gateway :8080 (single LAN entry point)
           ├─ GET /        → static control center (gateway/public/index.html)
           ├─ /api/*       → control plane (admin key)
           ├─ /v1/*        → OpenAI API, reverse-proxied (inference key)
           ├─ /ws          → realtime events (admin key)
           └─ node http-proxy → lightweight reverse proxy (lite nginx)
                └─► llama-server 127.0.0.1:8000 (never on the LAN)
                     ▲ webhook (numeric telemetry only)
                     │
      analytics :8081 (Python, planned) ──► Redis ──► SQLite (+ vector) store
        TFLite NN · PCA + risk · drift detection (offline-trained model)
        live scores back to gateway → /ws fan-out
```

- **One exposed port.** The gateway binds `0.0.0.0:8080`; only `8080:8080` is published. `llama-server` binds `127.0.0.1:8000` and is never on the LAN.
- **External runtime.** The GGUF model lives at `/opt/qwen-model` (mounted at `/models`); the `llama-server` binary lives at `/opt/llama` (mounted read-only). The Docker image stays small and independent of model size.
- **Runs on a glibc-2.41 base.** Both Dockerfiles build on `node:22-trixie-slim` (+ `libgomp1`). Every published arm64 llama.cpp release links against glibc ≥ 2.38 — older bookworm (glibc 2.36) cannot load them — and the trixie base matches the toolchain they are built with.
- **Two API keys.** Inference key for `/v1/*`, admin key for `/api/*` and `/ws`. Credentials never leave the gateway; neither is ever sent to `llama-server`.
- **Atomic model updates.** Replacements are staged under `/models/.download/`, verified (checksum when configured), then swapped in — the working model is never destroyed before its replacement is ready.
- **Startup sequencing.** Gateway refuses inference until `llama-server` reports ready.
- **Streaming supported.** `stream: true` responses pass through without buffering.
- **No prompt/response logging** by default.

## Repo layout

```
opencode-pi/
├── docker-compose.yml
├── Dockerfile               ← small: Node gateway only
├── .env.example
├── model/                   ← documents the model-as-data convention
├── analytics/               ← planned Python analytics microservice (analytics-layer doc)
├── gateway/
│   ├── public/index.html    ← single-file control center UI
│   └── src/                 ← Express + http-proxy + auth + model mgmt
│       ├── model/           ← atomic model download/install/ensure (actions under model/actions/)
│       └── modules/llama/   ← llama-server supervisor + shields + stats
├── docs/
│   └── analytics-layer.md   ← analytics & risk layer design (data contracts)
├── scripts/
│   ├── install.sh           ← provision llama.cpp into /opt/llama (host)
│   ├── update.sh            ← update llama runtime on host
│   └── cleanup.sh           ← remove known temp artifacts only
├── PRD.md                   ← full product requirements & API spec
└── README.md
```

## Quickstart

```bash
git clone <repository>
cd opencode-pi

cp .env.example .env
# Set MODEL_URL, INFERENCE_API_KEY, ADMIN_API_KEY, and any llama tuning vars

sudo mkdir -p /opt/qwen-model        # model data (external, survives recreation)
sudo ./scripts/install.sh            # provision llama-server into /opt/llama

docker compose build
docker compose up -d
```

`./scripts/install.sh` verifies the downloaded binary inside the gateway's runtime
image (`node:22-trixie-slim` + `libgomp1`) before installing it — so the container and
the binary are always a compatible pair.

On first start the system downloads and verifies the model automatically.

Check:

```bash
curl http://<pi-ip>:8080/health
```

Control center: `http://<pi-ip>:8080`

OpenCode config: base URL `http://<pi-ip>:8080/v1`, inference API key.

Do **not** point anything at `<pi-ip>:8000` — `llama-server` is internal only.

## Managing the model

- **Update** — control center → Model → **Update model**, or `curl -X POST /api/model/update`. The gateway downloads to a staging dir, verifies the SHA-256 when configured, then atomically swaps it in and reloads `llama-server`. Progress is streamed to the WebSocket and reflected in `/api/model`.
- **Restart** — control center → Model → **Restart model`, or `POST /api/model/restart`.
- **Cleanup** — `./scripts/cleanup.sh` removes known temporary artifacts only (never the working model).
- **llama runtime** — `./scripts/update.sh` swaps to a newer llama.cpp release; `./scripts/cleanup.sh` also removes the installed runtime cleanly.
- **llama release selection** — `install.sh`/`update.sh` default to the pinned, Pi-tested
  release `b9500`. `LLAMA_RELEASE=latest` is an explicit opt-in: it resolves the newest tag,
  but only downloads it if that tag actually publishes an arm64 binary asset (it falls back
  to `b9500` with a warning otherwise).
- **Runtime compatibility gate** — every download is verified twice before anything is
  swapped: once on the host, and once *inside the gateway's container runtime*
  (`node:22-trixie-slim` + `libgomp1`, the same base the Dockerfiles use). A newer release
  built for a glibc the container can't satisfy is rejected and falls back to `b9500`; if
  the default itself fails, the script aborts and leaves the current install untouched.
  Override the check image with `LLAMA_RUNTIME_IMAGE` (keep it in sync with the Dockerfiles).

For local testing of the scripts, `install.sh`/`update.sh`/`cleanup.sh` honor `LLAMA_DIR` / `MODEL_DIR` / `LLAMA_RELEASE` overrides and need no sudo when pointed at a writable temp directory.

## Environment summary

| Variable              | Purpose                          | Default       |
|-----------------------|----------------------------------|---------------|
| `GATEWAY_HOST`        | Gateway bind address             | `0.0.0.0`     |
| `GATEWAY_PORT`        | Gateway listen port              | `8080`        |
| `INFERENCE_API_KEY`   | Key for `/v1/*`                  | required      |
| `ADMIN_API_KEY`       | Key for `/api/*` + `/ws`         | required      |
| `LLAMA_HOST` / `PORT` | llama-server bind/port           | `127.0.0.1:8000` |
| `LLAMA_BIN`           | llama-server path in container   | `/opt/llama/llama-server` |
| `LLAMA_CONTEXT_SIZE`  | Context window                   | `8192`        |
| `LLAMA_*`             | threads / batch / parallel / extra args | (unset) |
| `MODEL_NAME`          | Model display name               | `Qwen3-1.7B`   |
| `MODEL_URL`           | GGUF download URL                | required      |
| `MODEL_FILE`          | Active filename in `/models`     | `current.gguf` |
| `MODEL_SHA256`        | Optional download checksum       | (unset)       |
| `MODEL_DIR`           | Host model directory             | `/opt/qwen-model` |
| `AUTO_UPDATE_MODEL`   | Opt-in automatic updates         | `false`       |
| `ANALYTICS_PORT`      | Analytics microservice port      | `8081`        |
| `ANALYTICS_URL`       | Gateway → analytics base URL     | `http://analytics:8081` |
| `INGEST_SECRET`       | Shared secret for the webhook    | required      |
| `REDIS_URL`           | Redis connection string          | `redis://redis:6379` |
| `ANALYTICS_FEATURE_WINDOW_SEC` | Feature aggregation window | `60`    |
| `ANALYTICS_CONTEXT_WINDOWS` | Context windows fed to model   | `12`        |
| `ANALYTICS_EWMA_DECAY`| EWMA reference decay per window  | `0.005`       |

## API summary

| Area        | Surface       | Auth          |
|-------------|---------------|---------------|
| Health      | `GET /health` | none          |
| Control     | `GET /api/status`, `/api/model`, `/api/system`, `/api/system/host`, `/api/metrics`, `/api/logs`, `/api/requests`, `/api/analytics/*` | admin key |
| Operations  | `POST /api/model/update`, `/api/model/restart`, `/api/server/restart` | admin key |
| Inference   | `GET /v1/models`, `POST /v1/chat/completions` | inference key |
| Realtime    | `WS /ws`      | admin key     |
| Analytics (planned) | `POST :8081/v1/analytics/ingest` (webhook), `GET …/training/export`, `GET …/historic/windows`, `POST …/scores`, `POST …/rebaseline` | shared secret |

## Control center

The single-file UI at `gateway/public/index.html` (served at `http://<pi-ip>:8080`) covers
connection (admin key), the model panel (name, quant, status, size, install date, tok/s,
download progress, restart/update), and live realtime events over `/ws`.

### Control Center v2

- **Metric row.** `Connection` · `System` · `Model` as equal-height cards. The System card
  tabulates CPU %, Memory % (Viridis load-colored), temperature, disk, token rate, and rolling
  **API calls/min**, fed by `/api/system` + live `system.metrics` WS events.
- **Inference streams table.** A bounded table of `/v1/*` requests — time, request id,
  status, tokens (prompt/completion/total), tok/s, duration — backfilled from
  `GET /api/requests` and updated live via `request.started`/`request.completed`/`request.error`
  WebSocket events. The `tok/s` cell is tinted on a Viridis ramp (slow → fast); error statuses
  are clickable and expand the error reason.
- **Host card (fastfetch-style).** OS, hostname, kernel, arch, Pi hardware model, CPU model +
  cores, total memory, uptime, local IP from `GET /api/system/host` — the container-visible
  host details (real Pi CPU/kernel/uptime/memory; OS reflects the container image).
- **Playground.** A multi-turn chat conversation window that streams through the same
  `/v1/chat/completions` path as OpenCode (uses the inference key; Send + Stop); every
  exchange shows up in the streams table.
- **Realtime events log.** Tagged, color-coded, auto-scrolling log capped at 300 lines with a
  **Clear** button.
- **Layout.** The page is a shell — a fixed left sidebar (brand + section links with
  per-card accent markers, scrollspy active highlight, collapsing to a compact rail on narrow
  screens) and a fixed bottom status bar (live gateway/llama/model chips, CPU%, memory%,
  token rate, API/min, ticking clock, theme toggle). On wide screens the cards form a grid —
  metric row, then `Host | Playground`, then the streams table directly above the full-width
  log window; one column on narrow screens. Each card carries its own accent color
  (Connection, System, Model, Host, Playground, Streams, Events) on a top border and title,
  with a subtle glow/hover/pulse treatment.
- **Theme toggle.** Cycles four themes — `Dark` (default), `Viridis` (subtle Viridis tint),
  `Whale` (cool ocean blues), `Rosé Pine` — persisted in `localStorage`. The toggle lives in
  the top bar and the bottom status bar.
- **Typography.** The monospace face is `JetBrainsMono Nerd Font`, then `JetBrains Mono`
  (web fallback), then the system mono stack.

Implemented backend support: a bounded request ring in the gateway — numeric telemetry only,
never prompt/response content (preserves the no-logging rule) — exposed via
`GET /api/requests` and the `request.*` WebSocket events, plus `GET /api/system/host` and a
rolling `requestsPerMinute` on `/api/system` / `/api/metrics` / `system.metrics` (PRD §6.12,
§9.4–9.8). Token counts come from response `usage` when present (non-stream JSON) and from
llama-server's own `slot print_timing` accounting for streams (llama's streaming chunks carry
no `usage`); unknown counts display as `—`.

## Analytics & risk layer (planned)

A separate Python microservice (`analytics/`, port `8081`) gives the control center a
data-science / ML layer for drift detection and risk scoring — **numeric-only telemetry,
never prompt/response/reasoning content**.

- **Ingest webhook.** The gateway pushes per-request records and 60s window aggregates to
  `POST /v1/analytics/ingest` (shared secret). On outage, batches queue in Redis and flush on
  reconnect — no loss, no inference backpressure. (Push cadence is TBD.)
- **Context windows.** Features (per-request token counts/duration/tok/s, window
  requests/min + error rate + p95/p99, system cpu/mem/temp/disk at inference time) roll into
  60s windows; the model consumes the last `ANALYTICS_CONTEXT_WINDOWS` windows as its input
  tensor.
- **Adaptive EWMA reference.** Mean/σ and PCA loadings decay slowly, so risk reads as
  "drift from the recent norm"; a manual re-fit endpoint is available.
- **PCA + 1.5σ risk model.** Hotelling `T²` of standardized scores → exact `F/χ²` tail
  probability; "≥1.5σ" per component is the two-tailed normal tail (p ≈ 0.134), aggregated
  across k components. Levels: normal / watch (>1.5σ) / high. Drift via feature PSI, KS/MMD
  on PC scores, and loading shift.
- **SQLite vector/embedding store + Redis.** Windows and requests are stored with feature
  vectors and NN embeddings (`sqlite-vec` index) for historic lookback; Redis backs the key
  cache, per-key rate limits, the ingest escrow, and the live-score cache.
- **TF-Lite neural net.** A small offline-trained model (context window → risk/drift
  probabilities) served via TFLite in Python; training/quantization happens outside the
  running services.
- **Live result transport — gateway fan-out.** Analytics POSTs scores/drift to the gateway,
  which broadcasts `analytics.risk` / `analytics.drift` over the existing admin `/ws`. The
  Control Center gains an Analytics card; historic analysis is admin-proxied via
  `/api/analytics/*`.
- **Training data endpoint.** `GET /v1/analytics/training/export` (shared secret) or the
  admin proxy `GET /api/analytics/training/export` returns labeled JSONL/CSV — each window
  with `features`, `context`, `pcs`, `risk` and the `normal | watch | high` label
  auto-derived from the risk model. Raw paging via `GET /v1/analytics/historic/windows`.

Full data contracts: [`docs/analytics-layer.md`](docs/analytics-layer.md) · PRD §6.13, §7.3.

## Documentation

- [`PRD.md`](PRD.md) — full product requirements: numbered requirement list (1–65), API and WebSocket specifications, model lifecycle, environment configuration, security, acceptance criteria, design principles, and future scope.
- [`docs/analytics-layer.md`](docs/analytics-layer.md) — analytics & risk layer design: feature/key/embedding schema and service↔service data contracts.

## Status

- [x] Gateway scaffold (Express + http-proxy + auth + validation)
- [x] Control center `index.html` (connection, model panel, realtime events)
- [x] Model lifecycle (ensure, atomic download/verify/swap, reload)
- [x] llama-server supervisor (spawn, health poll, backoff restart, tok/s)
- [x] Startup sequencing & readiness gating (`/v1` → 503 until ready)
- [x] Streaming inference pass-through (`/v1/*` SSE, credentials stripped)
- [x] Host `scripts/` (install, update, cleanup llama runtime)
- [x] Dockerfile + docker-compose (dev + test services)
- [x] Model first-run provisioning (1.83 GB Q8_0 downloaded, SHA-256 verified, atomically installed)
- [x] llama-server serves the model under the alias `--alias ${MODEL_NAME}`
- [x] End-to-end acceptance: streaming completion through `/v1` (llama ready, `modelLoaded`,
  `/v1/models` id `Qwen3-1.7B`, SSE tokens flowing, tok/s surfaced in `/api/system`)
- [x] Control Center v2: streams table (`GET /api/requests` + `request.*` WS), Playground,
  Viridis theme toggle, JetBrains Mono Nerd Font, no-overlap layout (PRD §6.12, §9.4–9.7)
- [ ] Analytics & risk layer: Python microservice, webhook ingest, EWMA + PCA risk,
  drift detection, SQLite vector store, Redis, gateway fan-out (PRD §6.13 — planned)

## Getting started from your laptop

The gateway serves the control center and the Qwen3-1.7B model on the Pi's LAN address.

### 1. Provision on the Pi

```bash
sudo /home/pi5_nvme/opencode-pi/scripts/install.sh    # installs /opt/llama, verifies against the container runtime
```

### 2. Run (and clean up) the stack

```bash
cd /home/pi5_nvme/opencode-pi

docker compose up -d --build          # build (if needed) + start gateway-dev
docker compose ps                     # gateway-dev Up; healthy after llama reports ready
docker compose restart gateway-dev    # restart without rebuilding
docker compose down                   # stop + remove the containers (volumes/mounts stay)
docker compose down -v && docker compose up -d --build   # full clean rebuild from scratch
```

`docker compose up -d --build` is the normal "run clean" path: it rebuilds the image when
the Dockerfiles or gateway deps changed, then starts the gateway.

### 3. Verify llama is serving

```bash
curl -s http://127.0.0.1:8080/api/status    # expect "llama":"ready", "modelLoaded":true
```

Find the Pi's LAN IP with `hostname -I` (e.g. `192.168.x.y`) and note the `INFERENCE_API_KEY`
from `gateway/.env` (or repo `.env`).

### 4. Access the control center

Browser → `http://<pi-ip>:8080` → enter the `ADMIN_API_KEY`. The model panel should show
`Qwen3-1.7B` with `ready`/`loaded` and live tok/s; the download progress bar only appears
during first-run provisioning.

### 5. Point opencode at the Pi

Create `~/.config/opencode/opencode.json` (on the Arch laptop):

```jsonc
{
"$schema": "https://opencode.ai/config.json",
"provider": {
"opencode-pi": {
"npm": "@ai-sdk/openai-compatible",
"name": "opencode-pi (LAN)",
"options": {
"baseURL": "http://<pi-ip>:8080/v1",
"apiKey": "<INFERENCE_API_KEY>"
},
"models": {
"Qwen3-1.7B": {
"name": "Qwen3-1.7B Q8_0",
"limit": {
"context": 8192,
"output": 2048
}
}
}
}
},
"model": "opencode-pi/Qwen3-1.7B"
}
```

- Each model ID must match what `GET /v1/models` returns — the gateway aliases the model
  to `Qwen3-1.7B`, so that is the ID to use. `"model"` at the top makes it the default;
  as a fallback pick it in the TUI with `/models`.
- `apiKey` is the `INFERENCE_API_KEY`; opencode sends it as `Authorization: Bearer`, which
  the gateway accepts (`x-api-key` works too).
- `chmod 600` the file. Expect ~3 tok/s at ctx 8192 (1.7B Q8_0 on the Pi 5, 4 threads).

### 6. Sanity check from the laptop (before running opencode)

```bash
curl -s http://<pi-ip>:8080/v1/models -H "Authorization: Bearer <INFERENCE_API_KEY>"
# data[0].id should be "Qwen3-1.7B"

curl -N -s http://<pi-ip>:8080/v1/chat/completions \
  -H "Authorization: Bearer <INFERENCE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen3-1.7B","stream":true,"messages":[{"role":"user","content":"Hi"}]}'
# SSE chunks should stream back
```

If either hangs or fails: laptop and Pi not on the same subnet, or the Pi firewall is
blocking TCP 8080 for the LAN (allow it on your subnet only).

### Known behaviors

- `POST /api/server/restart` cleanly exits the gateway process; recovery is the supervisor's
  job (Docker `restart` policy in prod, manual `docker compose restart gateway-dev` in dev —
  `tsx watch` in dev mode does not respawn the app on self-exit).
- First boot after switching models downloads the GGUF to `/opt/qwen-model` (host) before
  `llama-server` starts; `/v1` returns 503 during the download. The control center shows the
  progress bar.
- `llama-server` is never auto-bootstrapped: if `/opt/llama` is empty the supervisor logs
  `run ./scripts/install.sh` and parks in `error` until a manual restart after provisioning.
