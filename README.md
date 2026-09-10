# opencode-pi

A self-hosted, LAN-only local AI control center for a Raspberry Pi 5. Runs a quantized Qwen2.5-Coder-3B-Instruct (Q4_K_M) GGUF model through llama.cpp's `llama-server`, exposes an OpenAI-compatible inference API to OpenCode (and any OpenAI-compatible client) on your local network, and ships a React + Vite + Tailwind browser control center (built from `ui/` into `gateway/public/`) for monitoring and operating the system.

## What it does

- **Runs Qwen2.5-Coder-3B-Instruct locally** on a Raspberry Pi 5 (Q4_K_M quant).
- **Exposes one OpenAI-compatible endpoint** to OpenCode over the LAN: `http://<pi-ip>:8080/v1`.
- **Keeps the model out of the image.** The GGUF and the `llama-server` binary are both external — mounted in, never baked in.
- **Provisions the model automatically.** On first start, if `current.gguf` is missing it is downloaded, verified, and atomically installed.
- **Manages the model safely.** Single active model on disk, atomic swaps, no accumulation of old GGUFs, updates via script or the control center.
- **Serves a control center** for status, metrics, live logs, model management, and a test chat interface.

## Architecture

```
LAN ──► Express Gateway :8080 (single LAN entry point)
           ├─ GET /        → static control center (React SPA, ui/ → gateway/public/)
           ├─ /api/*       → control plane + analytics proxies (admin key)
           ├─ /api/analytics/stream → live SSE (admin key)
           ├─ /v1/*        → OpenAI API, reverse-proxied (inference key)
           ├─ /ws          → realtime events (admin key)
           └─ node http-proxy → lightweight reverse proxy (lite nginx)
                └─► llama-server 127.0.0.1:8000 (never on the LAN)
                     ▲ webhook (numeric telemetry only; bounded Redis escrow on outage)
                     │
      analytics :8081 (internal, gateway-proxied only)
        │  ML serving layer · EWMA + PCA (top-3-PC ±1.5σ label) · drift · lookalikes
        │  └─► analytics-train (no exposed port, UI-startable TFLite training → /opt/qwen-ml)
        │  live results → gateway → /ws fan-out + SSE stream /api/analytics/stream
        └──► Redis (warehoused volume) ──► SQLite (+ 2 sqlite-vec embedding stores, external mount)
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
├── Dockerfile               ← small: Node gateway only (TS compiled)
├── .env.example
├── ui/                      ← control-center UI (React + Vite + Tailwind, TS)
├── gateway/
│   ├── public/              ← served by express.static: index.html + assets/
│   │   └── index.html       ← built SPA copied here from ui/dist (one-shot swap)
│   └── src/                 ← Express + http-proxy + auth + model mgmt
│       ├── model/           ← atomic model download/install/ensure (actions under model/actions/)
│       └── modules/llama/   ← llama-server supervisor + shields + stats
├── analytics/               ← live analytics & risk microservice (Python/FastAPI; PRD §6.13, README.md in analytics/)
├── docs/
│   └── analytics-layer.md   ← analytics & risk layer design (data contracts)
├── model/                   ← documents the model-as-data convention
├── scripts/
│   ├── install.sh           ← provision llama.cpp into /opt/llama (host)
│   ├── update.sh            ← update llama runtime on host
│   └── cleanup.sh           ← remove known temp artifacts only
├── .ai/                     ← agent memory (sessions/ + decisions/, see .ai/README.md)
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

## UI development (React + Vite + Tailwind)

The control center lives in `ui/` and is served by the gateway from `gateway/public/`
— the built SPA is copied there after every change. Zero gateway runtime changes.

- **Dev:** `docker compose up ui-dev` runs the Vite dev server on `:5173` with a
  proxy for `/api`, `/v1`, `/ws`, `/health` to the gateway. It does **not** validate
  the shipped bundle (Vite 5.4 blocks non-localhost Host headers — `allowedHosts` is
  already configured in `ui/vite.config.ts`).
- **Build + verify (authoritative):** in a node:22 container —
  `npm ci && npx tsc --noEmit && npx vite build && npx vitest run` — then copy the
  result: `cp ui/dist/index.html gateway/public/index.html` and
  `cp ui/dist/assets/* gateway/public/assets/*`.
- **Regression bar:** a Playwright sweep (`pi-sweep` image, `ui-sweep-spa.mjs`) must
  show all 9 views rendering with zero console/page errors, WS + wire connected, and
  zero page-level horizontal overflow (cards own inner `overflow-x:auto`; the fixed
  220px rail matches legacy). Detail records and rationale live in
  `.ai/sessions/ui-refactor/` and `.ai/decisions/ui-refactor/`.

## Environment summary

| Variable              | Purpose                          | Default       |
|-----------------------|----------------------------------|---------------|
| `GATEWAY_HOST`        | Gateway bind address             | `0.0.0.0`     |
| `GATEWAY_PORT`        | Gateway listen port              | `8080`        |
| `INFERENCE_API_KEY`   | Key for `/v1/*`                  | required      |
| `ADMIN_API_KEY`       | Key for `/api/*` + `/ws`         | required      |
| `LLAMA_HOST` / `PORT` | llama-server bind/port           | `127.0.0.1:8000` |
| `LLAMA_BIN`           | llama-server path in container   | `/opt/llama/llama-server` |
| `LLAMA_CONTEXT_SIZE`  | Context window (Qwen2.5-Coder-3B-Instruct max 32768) | `32768`        |
| `LLAMA_*`             | threads / batch / parallel / extra args | (unset) |
| `MODEL_NAME`          | Model display name               | `Qwen2.5-Coder-3B-Instruct`   |
| `MODEL_URL`           | GGUF download URL                | required      |
| `MODEL_FILE`          | Active filename in `/models`     | `current.gguf` |
| `MODEL_SHA256`        | Optional download checksum       | (unset)       |
| `MODEL_DIR`           | Host model directory             | `/opt/qwen-model` |
| `AUTO_UPDATE_MODEL`   | Opt-in automatic updates         | `false`       |
| `ANALYTICS_PORT`      | Analytics microservice port      | `8081`        |
| `ANALYTICS_URL`       | Gateway → analytics base URL     | `http://analytics:8081` |
| `INGEST_SECRET`       | Shared secret for the webhook    | required      |
| `REDIS_URL`           | Redis connection string          | `redis://redis:6379` |
| `ANALYTICS_GATEWAY_URL` | Analytics → gateway base URL   | `http://gateway-dev:8080` |
| `ANALYTICS_FEATURE_WINDOW_SEC` | Feature aggregation window | `60`    |
| `ANALYTICS_CONTEXT_WINDOWS` | Context windows fed to model   | `12`        |
| `ANALYTICS_EWMA_DECAY`| EWMA reference decay per window  | `0.1`       |
| `ANALYTICS_ML_DIR`    | Host ML artifacts dir            | `/opt/qwen-ml` |
| `ANALYTICS_DB_FILE`   | SQLite store file (host, survives `down -v`) | `/opt/qwen-ml/analytics.db` |
| `ANALYTICS_PCA_COMPONENTS` | Max PCA components retained  | `6`            |
| `ANALYTICS_PCA_WATCH_Z` / `ANALYTICS_PCA_HIGH_Z` | Top-3-PC σ thresholds (watch / high) | `1.0` / `1.5` |
| `ANALYTICS_EMBED_ENABLED` / `ANALYTICS_EMBED_MODEL` | Lookalike embedding stores / embedder | `true` / (unset) |
| `ANALYTICS_TRAIN_MIN_ROWS` | Labeled windows before first build | `4000` |
| `ANALYTICS_TRAIN_EPOCHS` | Base epoch budget per trial | `10` |
| `ANALYTICS_TRAIN_BATCH` | Default batch size | `64` |
| `ANALYTICS_TRAIN_TRIALS` | Random-search hyperparameter trials | `5` |
| `ANALYTICS_TRAIN_VALIDATION` | Validation split fraction | `0.2` |
| `ANALYTICS_TRAIN_SEED` | Random-search seed | `7` |
| `REDIS_PERSISTENT`    | Persist Redis (volume + appendonly) | `true`        |

## API summary

| Area        | Surface       | Auth          |
|-------------|---------------|---------------|
| Health      | `GET /health` | none          |
| Control     | `GET /api/status`, `/api/model`, `/api/system`, `/api/system/host`, `/api/metrics`, `/api/logs`, `/api/requests`, `/api/analytics/*` | admin key |
| Operations  | `POST /api/model/update`, `/api/model/restart`, `/api/server/restart` | admin key |
| Inference   | `GET /v1/models`, `POST /v1/chat/completions` | inference key |
| Realtime    | `WS /ws` + SSE `GET /api/analytics/stream` | admin key |
| Analytics (planned) | `POST :8081/v1/analytics/ingest` (webhook → bounded escrow), `GET …/stream` (SSE), `…/training/export`, `…/historic/windows`, `…/pca`, `…/lookalikes`, `POST …/scores`, `…/rebaseline`, `…/training/start`, `GET …/training/status`, `…/pipelines`, `…/warehouse/sql`, `…/warehouse/redis` | shared secret (internal) → admin-proxied under `/api/analytics/*` |

## Control center

The control-center UI (React + Vite + Tailwind SPA at `ui/`, served from
`gateway/public/` at `http://<pi-ip>:8080`) covers connection (admin key), the model
panel (name, quant, status, size, install date, tok/s, download progress,
restart/update), and live realtime events over `/ws`. See **UI development** above for
the build/rebuild/regression workflow.

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

## Analytics & risk layer (live 2026-09-07)

A separate Python microservice (`analytics/`, port `8081`, internal) gives the control
center a live ML layer for drift detection and risk scoring — **numeric-only telemetry,
never prompt/response/reasoning content**. All access is through the gateway; `:8081` is
never published, and the external Qwen project reads the same admin-proxied
`/api/analytics/*` surface on `:8080`.

- **Ingest webhook.** The gateway pushes per-request records and 60s window aggregates to
  `POST /v1/analytics/ingest` (shared secret) on a 5s prime then every
  `ANALYTICS_FEATURE_WINDOW_SEC`. On outage, windows queue in an in-memory bounded backlog
  (48) and flush on reconnect — no inference backpressure.
- **Context windows.** Features (per-request token counts/duration/tok/s, window
  requests/min + error rate + p95/p99, system cpu/mem/temp/disk at inference time) roll into
  60s windows; the model consumes the last `ANALYTICS_CONTEXT_WINDOWS` windows as its input
  tensor.
- **Adaptive EWMA reference.** Mean/σ and PCA loadings decay slowly, so risk reads as
  "drift from the recent norm"; `POST /api/analytics/rebaseline` re-fits from stored windows.
- **PCA + top-3-PC label.** Retains up to `ANALYTICS_PCA_COMPONENTS` (6) components over the
  current rolling window. **High risk** whenever any top-3 principal component is
  `z ≤ −1.5 or z ≥ +1.5` (signed — both directions trip); **watch** for `1.0 ≤ |z| < 1.5`;
  otherwise **normal**. Hotelling `T²` (pure-Python Jacobi eigh + χ² tail, no scipy)
  supports the label with an F/χ² tail probability (`confidence = 1 − p`).
- **Live result transport.** Every new window triggers a live re-score broadcast over the
  admin `/ws` (`analytics.*`, `training.*`, `store.*`, `pca` events) **and** the SSE stream
  `GET /api/analytics/stream` (admin-proxied one-hop pipe from analytics `:8081`), so both
  the UI and the external Qwen client hold live connections. Risk output is the
  `PcaSummary` contract (`projection`, `components`, `variance`, `eigenvalues`,
  `totalVariance`, `mean`, `std`, `drift`, `driftClassification`, `risk`, `confidence`,
  `heartbeat`, `lastRun`); history is `HistoryPoint[]` at
  `GET /api/analytics/historic/windows`.
- **SQLite + Redis warehouse.** Windows/requests carry feature vectors, context tensors,
  PCA loadings/scores and the risk label in SQLite (external mount, WAL); Redis caches
  `score:latest` and `train:state` (persisted volume + appendonly). Both surface in
  `GET /api/analytics/warehouse/sql` and `/warehouse/redis`.
- **In-app TensorFlow training.** The first build happens at
  `ANALYTICS_TRAIN_MIN_ROWS` labeled windows; afterwards the saved model is loaded and
  fine-tuned on every new write (storage is never wiped). Each run performs
  `ANALYTICS_TRAIN_TRIALS` random-search hyperparameter trials (units/layers/dropout/lr/
  batch/epochs) and logs per-trial **precision, recall, accuracy, F1 and the 3×3 confusion
  matrix** to the `training_runs` table; every trial streams as a `training.progress` WS/SSE
  event, and the best model (macro-F1, falling back to accuracy) is exported as SavedModel +
  TFLite to `/opt/qwen-ml` and announced via `training.done`.
- **Training data endpoint.** `GET /v1/analytics/historic/windows` returns the labeled
  window history (`HistoryPoint[]`): `timestamp`, `projection`, `drift`, `risk`.
  Full labeled export (features + pcs + risk) lands with the dedicated export endpoint.

Full data contracts: [`docs/analytics-layer.md`](docs/analytics-layer.md) · PRD §6.13, §7.3.

## Documentation

- [`PRD.md`](PRD.md) — full product requirements: numbered requirement list (1–69), API and WebSocket specifications, model lifecycle, environment configuration, security, acceptance criteria, design principles, and future scope.
- [`docs/analytics-layer.md`](docs/analytics-layer.md) — analytics & risk layer design: feature/key/embedding schema and service↔service data contracts.
- [`analytics/README.md`](analytics/README.md) — analytics service operation: modules, pipeline, config, tests.

## Status

- [x] Gateway scaffold (Express + http-proxy + auth + validation)
- [x] Control center `index.html` (connection, model panel, realtime events)
- [x] Model lifecycle (ensure, atomic download/verify/swap, reload)
- [x] llama-server supervisor (spawn, health poll, backoff restart, tok/s)
- [x] Startup sequencing & readiness gating (`/v1` → 503 until ready)
- [x] Streaming inference pass-through (`/v1/*` SSE, credentials stripped)
- [x] Host `scripts/` (install, update, cleanup llama runtime)
- [x] Dockerfile + docker-compose (dev + test services)
- [x] Model first-run provisioning (Qwen2.5-Coder-3B-Instruct Q4_K_M, SHA-256 verified, atomically installed)
- [x] llama-server serves the model under the alias `--alias ${MODEL_NAME}`
- [x] End-to-end acceptance: streaming completion through `/v1` (llama ready, `modelLoaded`,
  `/v1/models` id `Qwen2.5-Coder-3B-Instruct`, SSE tokens flowing, tok/s surfaced in `/api/system`)
- [x] Control Center v2: streams table (`GET /api/requests` + `request.*` WS), Playground,
  Viridis theme toggle, JetBrains Mono Nerd Font, no-overlap layout (PRD §6.12, §9.4–9.7)
- [x] Analytics & risk layer: Python microservice (analytics + analytics-train), webhook
  ingest, ML serving layer (WS + SSE), TF-Lite NN risk + EWMA + PCA drift, SQLite vector
  store + warehoused Redis, gateway fan-out, ML Analytics UI (PRD §6.13, analytics/README.md)
- [x] UI refactor: `ui/` React + Vite + Tailwind SPA (9 views), built into
  `gateway/public/`, production image + Playwright regression verified
  (`.ai/sessions/ui-refactor/`)

## Getting started from your laptop

The gateway serves the control center and the Qwen2.5-Coder-3B-Instruct model on the Pi's LAN address.

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
`Qwen2.5-Coder-3B-Instruct` with `ready`/`loaded` and live tok/s; the download progress bar only appears
during first-run provisioning.

### 5. Point opencode at the Pi

Create `~/.config/opencode/opencode.json` (on the Arch laptop) — a **sample**; replace the
placeholder values (no secrets or machine-specific addresses are baked into the README):

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
        "Qwen2.5-Coder-3B-Instruct": {
          "name": "Qwen2.5-Coder-3B-Instruct Q4_K_M",
          "limit": { "context": 32768, "output": 32768 }
        }
      }
    },

    "google": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Google Gemini",
      "options": {
        "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "apiKey": "{env:GEMINI_API_KEY}"
      },
      "models": {
        "gemini-3.6-flash": {
          "name": "Gemini 3.6 Flash",
          "limit": { "context": 1048576, "output": 8192 }
        }
      }
    }
  },

  "model": "google/gemini-3.6-flash"
}
```

- Each model ID must match what `GET /v1/models` returns — the gateway aliases the model
  to `Qwen2.5-Coder-3B-Instruct`, so that is the ID to use. `"model"` at the top makes Google
  Gemini the default; as a fallback pick a model in the TUI with `/models`.
- `apiKey` is the `INFERENCE_API_KEY`; opencode sends it as `Authorization: Bearer`, which
  the gateway accepts (`x-api-key` works too).
- `chmod 600` the file. Expect a few tok/s (3B Q4_K_M on the Pi 5, 4 threads); the
  actual speed at a given request drops as the context fills; a full 32768-token
  context keeps the KV cache and prompt-eval time modest on the Pi's 4 cores.

### 6. Sanity check from the laptop (before running opencode)

```bash
curl -s http://<pi-ip>:8080/v1/models -H "Authorization: Bearer <INFERENCE_API_KEY>"
# data[0].id should be "Qwen2.5-Coder-3B-Instruct"

curl -N -s http://<pi-ip>:8080/v1/chat/completions \
  -H "Authorization: Bearer <INFERENCE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen2.5-Coder-3B-Instruct","stream":true,"messages":[{"role":"user","content":"Hi"}]}'
# SSE chunks should stream back
```

If either hangs or fails: laptop and Pi not on the same subnet, or the Pi firewall is
blocking TCP 8080 for the LAN (allow it on your subnet only).

### 7. Swap the model

The loaded model is configuration, not code — swapping it never touches `/opt/llama`
or the image. Point `.env` (and/or the `install.sh`/`update.sh` defaults) at the new
GGUF, then run the atomic update; a failed swap leaves `current.gguf` untouched.

The current default is **Qwen2.5-Coder-3B-Instruct** Q4_K_M from the official
`Qwen/Qwen2.5-Coder-3B-Instruct-GGUF` repo (`qwen2.5-coder-3b-instruct-q4_k_m.gguf`,
~2.10 GB, SHA-256 `724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7`).
Full runbook: PRD §10.7.

**Script path (recommended):** `scripts/install.sh` (and `scripts/update.sh`) provision
the model — download → SHA-256 verify → atomic swap into `$MODEL_DIR/current.gguf` —
and point `.env` at the target values:

```bash
sudo ./scripts/install.sh                # installs llama + the default (Q4_K_M) model
sudo ./scripts/install.sh --clean-old    # also delete the preserved previous model
docker compose up -d                     # recreate gateway with the new env
```

The previous model is preserved as `$MODEL_DIR/.previous.gguf` for rollback; remove
it deliberately with `--clean-old` or later with
`sudo ./scripts/cleanup.sh --previous-model`.

Runtime: after `docker compose up -d`, check the Control Center or
`GET /api/model` for `"quantization":"Q4_K_M"` and confirm tok/s lands in the UI.

**Gateway API path:**

1. Back up the current `MODEL_NAME`, `MODEL_URL`, `MODEL_SHA256`, `MODEL_QUANT` from `.env`.
2. Set them to the new model's values (e.g. the Qwen2.5-Coder target above), or to any
   other GGUF URL.

   ```bash
   MODEL_NAME=Qwen2.5-Coder-3B-Instruct
   MODEL_URL=https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf
   MODEL_SHA256=724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7
   MODEL_QUANT=Q4_K_M
   ```

3. Reload the env — `docker compose up -d` (Compose recreates the service because the
   env file changed; `restart` alone keeps the old env).
4. Swap: Control Center → Model → **Download & Update**, or

   ```bash
   curl -s -X POST http://127.0.0.1:8080/api/model/update -H "x-api-key: <ADMIN_API_KEY>"
   ```

5. Verify: `/api/model` shows the new `"name"` / `"quantization"`; `/v1/models` id
   matches `MODEL_NAME`.
6. Rollback: restore the saved values in `.env`, `docker compose up -d`, run the update
   again.

Note: because the model ID (the `--alias`, exposed by `/v1/models`) changed to
`Qwen2.5-Coder-3B-Instruct`, update the laptop opencode config (`opencode.json`, §5) to
the new model ID — unlike the previous quant-only swap, the ID is different now.

### Known behaviors

- `POST /api/server/restart` cleanly exits the gateway process; recovery is the supervisor's
  job (Docker `restart` policy in prod, manual `docker compose restart gateway-dev` in dev —
  `tsx watch` in dev mode does not respawn the app on self-exit).
- First boot after switching models downloads the GGUF to `/opt/qwen-model` (host) before
  `llama-server` starts; `/v1` returns 503 during the download. The control center shows the
  progress bar.
- `llama-server` is never auto-bootstrapped: if `/opt/llama` is empty the supervisor logs
  `run ./scripts/install.sh` and parks in `error` until a manual restart after provisioning.
