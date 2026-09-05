# opencode-pi — Product Requirements Document

- **Product:** opencode-pi
- **Status:** Draft v0.3 (integrates original product spec §1–40, control-plane additions §41–42, and Control Center v2 §6.12 + §9.4–9.7)
- **Date:** 2026-09-05
- **Owner:** <tbd>

## 1. Overview

opencode-pi is a self-hosted, LAN-only local AI control center running on a Raspberry Pi 5. It runs a quantized Qwen3-1.7B (Q8_0) GGUF model through llama.cpp's `llama-server`, exposes an OpenAI-compatible inference API to OpenCode (and any OpenAI-compatible client) on the local network, and ships a clean, single-file browser control center for monitoring and operating the system.

The inference path is deliberately simple and isolated: one Express gateway is the single entry point for every client, and the model server is bound to localhost only. Nothing touches the model except the gateway.

## 2. Scope & Hosting

The Raspberry Pi 5 hosts:

- Node.js/Express gateway
- llama.cpp `llama-server` (binary provisioned on the host, mounted into the container)
- Quantized Qwen3-1.7B (Q8_0) GGUF model (external data, never baked into the image)
- Model lifecycle/update management
- Health and status endpoints

An Arch Linux laptop runs OpenCode and communicates with the Pi over the local network.

The model itself MUST NOT be baked into the Docker image. The model is external, replaceable runtime data.

## 3. Goals / Non-Goals

### Primary goals

- Run Qwen3-1.7B locally on Raspberry Pi 5.
- Use a quantized GGUF model suitable for Pi hardware.
- Expose an OpenAI-compatible API to OpenCode.
- Put the Node gateway and `llama-server` in one Docker container (binary mounted from host, model mounted as external data).
- Keep `llama-server` inaccessible directly from the LAN.
- Allow the Arch laptop to access only the Node gateway.
- Automatically download the model on first startup.
- Support clean model upgrades.
- Never permanently accumulate old model files.
- Keep Docker image size independent of model size.
- Allow the entire system to be recreated with Docker Compose.
- Make the system easy to scaffold and extend later.

### Non-Goals (initial scope)

The initial version will NOT:

- Train or fine-tune models.
- Host multiple models simultaneously.
- Require Kubernetes.
- Require a cloud service.
- Expose `llama-server` directly to the network.
- Store multiple generations of large GGUF files.
- Require the Arch laptop to host inference.
- Bake GGUF model files into Docker images.
- Require external SaaS or cloud dependencies for core operation.

## 4. Architecture

```
                         LAN
                          │
             ┌────────────┴────────────┐
             │                         │
             ▼                         ▼
       Arch Laptop                Other Browser
       ┌──────────┐               ┌──────────┐
       │ OpenCode │               │   UI     │
       └────┬─────┘               └────┬─────┘
            │ :8080/v1                  │ :8080
            └──────────────┬───────────────┘
                           ▼
                 ┌───────────────────────────┐
                 │     Express Gateway       │  :8080 (only LAN port)
                 │                           │
                 │  node http-proxy          │  ← lightweight reverse proxy
                 │  (lite nginx role)        │
                 │                           │
                 │  Static UI      GET /     │  → public/index.html
                 │  Control API    /api/*    │  (admin key)
                 │  OpenAI API     /v1/*     │  (inference key, proxied)
                 │  WebSocket      /ws       │  (admin key)
                 │  Authentication           │
                 │  Model management         │
                 │  Health / status          │
                 │  Metrics                  │
                 └─────────────┬─────────────┘
                               │
                       127.0.0.1:8000
                               │
                               ▼
                 ┌─────────────────────┐
                 │    llama-server     │
                 │                     │
                 │ Qwen3-1.7B GGUF │
                 └─────────────────────┘
```

### 4.1 Network architecture

Only the Node gateway is exposed to the LAN.

```
Arch laptop
   │
   │ http://192.168.1.50:8080
   ▼
Express Gateway
   │
   │ http://127.0.0.1:8000
   ▼
llama-server
```

- `llama-server` MUST bind to `127.0.0.1:8000`.
- The Node gateway MUST bind to `0.0.0.0:8080`.
- Docker MUST publish only `8080:8080`.
- Docker MUST NOT publish `8000:8000`.

### 4.2 Component responsibilities

**Express Gateway (:8080)** — the single entry point on the LAN.

- **HTTP API.** OpenAI-compatible inference endpoints plus the control API.
- **Reverse proxy.** Uses `node http-proxy` as a lightweight alternative to nginx. It routes incoming requests to the right internal handler and proxies the OpenAI inference path to `llama-server`. Clients only ever see port `:8080`.
- **Authentication.** Validates the inference key and the admin key. Credentials are stripped before anything is forwarded to `llama-server`.
- **Request validation.** Limits body size and validates requests before forwarding.
- **llama-server lifecycle awareness.** Starts, monitors, and restarts `llama-server`; gates inference until it is ready.
- **Health checks.** Exposes liveness and readiness, and monitors `llama-server` availability.
- **Model status / gateway status.** Reports state for both.
- **Request logging.** Logs request lifecycle without logging prompt or response contents by default.
- **Streaming response forwarding.** Streams `llama-server` responses through to OpenAI-compatible clients without buffering.
- **Static UI.** Serves the control center from `gateway/public/index.html`.
- **Control plane.** `/api/*` endpoints for status, model management, and operations.
- **Realtime plane.** WebSocket server on `/ws`.
- **Model management.** Owns the model lifecycle: download/update, atomic swap, restart, tracking load status.

**llama-server (127.0.0.1:8000)** — the inference engine, provided by llama.cpp. It runs inside the gateway container, bound to localhost only, and is never published to the LAN. It natively implements the OpenAI-compatible API that the gateway proxies (`/v1/models`, `/v1/chat/completions`).

### 4.3 Runtime provenance (model and binary are both external)

- **Model files** live on the host at `/opt/qwen-model/` and are mounted into the container at `/models`. They are never stored in the image.
- **The `llama-server` binary** is provisioned on the host (see `scripts/install.sh`, `scripts/update.sh`, `scripts/cleanup.sh`) and mounted into the container read-only at `/opt/llama`. It is not baked into the image.
- The Docker image therefore contains only the Node gateway and is small and independent of both the model size and the llama runtime version.

### 4.4 Boundary rules

- `/v1/*` → Inference API. `/api/*` → Control API. `/ws` → Realtime events.
- The frontend communicates **only** with the gateway. It never talks to `llama-server`.
- The browser never has direct filesystem access; model files and llama runtime operations are only touched via the gateway API or the host-side scripts.
- Credentials never leave the gateway and are never forwarded to `llama-server`.

## 5. Repo Layout

```
opencode-pi/
├── docker-compose.yml
├── Dockerfile               ← small: Node gateway only (TS compiled)
├── .env.example
├── .gitignore
├── .dockerignore
├── PRD.md
├── README.md
│
├── model/
│   └── README.md            ← documents the model-as-data convention and /opt/qwen-model
│
├── gateway/                 ← Express gateway (TypeScript)
│   ├── public/
│   │   └── index.html       ← single-file control center UI
│   ├── src/                 ← server, proxy, auth, model, config, log, metrics, ws, llama
│   ├── test/                ← vitest (auth rules, log ring)
│   ├── package.json
│   └── tsconfig.json
│
└── scripts/                 ← host-side and container-side tooling
    ├── entrypoint.sh        ← container entrypoint: signals, ensure model, exec node gateway
    ├── ensure-model.sh      ← first-run automatic model download (staging + atomic install)
    ├── update-model.sh      ← host-side model update runner (mirrors gateway update API)
    ├── healthcheck.sh       ← Docker healthcheck (running vs model actually ready)
    ├── install.sh           ← provision llama.cpp release into /opt/llama on the host
    ├── update.sh            ← update the host-installed llama.cpp binary
    └── cleanup.sh           ← remove known temporary artifacts (never the working model)
```

The actual model directory lives outside the repository: `/opt/qwen-model/`.

## 6. Requirements

### 6.1 Product & principles

1. **Local self-hosted.** The system runs entirely on the Raspberry Pi 5 without external cloud or SaaS dependencies.
2. **Two-machine topology.** The Pi 5 hosts everything (gateway, `llama-server`, model, lifecycle management). An Arch Linux laptop on the LAN runs OpenCode and consumes the OpenAI-compatible API.
3. **Quantized GGUF.** A quantized Qwen3-1.7B GGUF (Q8_0) suitable for Pi-class compute is used. Supported/configurable variants include Q4_K_M, Q5_K_M, Q6_K, and Q8_0.
4. **Simple, isolated inference path.** Clients → gateway → `llama-server`, with no other hops, caches, or middleware in the inference path.
5. **UI independent of model.** The control plane and control center are model-agnostic. Model name, URL, and quantization are configuration, not code — changing the model does not require application changes.

### 6.2 Architecture & boundaries

6. **Single network boundary.** The gateway binds `0.0.0.0:8080` and is the only port published by Docker (`8080:8080`). All client traffic enters here.
7. **llama-server on localhost.** `llama-server` binds `127.0.0.1:8000`; Docker MUST NOT publish `8000`. It is never directly reachable from the LAN.
8. **Gateway capabilities.** The gateway provides: HTTP API, reverse proxy, authentication, request validation, llama-server lifecycle awareness, health checks, model/gateway status, request logging, streaming response forwarding, and the control-center API.
9. **Plane separation.** `/v1/*` (inference), `/api/*` (control), and `/ws` (realtime) are distinct, separate surface areas with separate authorization.
10. **Frontend isolation.** The frontend communicates only with the gateway; it MUST NOT communicate directly with `llama-server`, and it never has direct filesystem access.

### 6.3 Model as external data

11. **Model is data, not application code.** GGUF model files MUST NOT be baked into the Docker image.
12. **Image size independent of model size.** The gateway image must remain small regardless of how large the model is.
13. **Single active model file.** Normally exactly one large GGUF exists on disk: `/opt/qwen-model/current.gguf` (mounted as `/models/current.gguf`). Temporary downloads may exist during updates under `/models/.download/` and MUST be cleaned up after success or failure. The system must never permanently accumulate old model files.
14. **Model volume lifecycle.** The model survives container recreation. Removing the container does not remove the model. Removing the model directory explicitly does remove the model. Docker/image cleanup MUST NOT accidentally delete the model volume.
15. **Atomic replacement only.** The working model is never destroyed before the replacement is downloaded, verified, and ready to become active.

### 6.4 Startup & provisioning

16. **Startup sequence.** Container startup: (1) ensure `/models` exists; (2) check whether `current.gguf` exists; (3) if missing, download the model; (4) verify the download; (5) start `llama-server`; (6) wait for `llama-server` health; (7) start the Node gateway; (8) gateway becomes available.
17. **First-run automatic download.** If `/models/current.gguf` is absent, the model is downloaded and atomically installed as `current.gguf`. The download never writes directly to `/models/current.gguf` — it is staged at `/models/.download/current.gguf.tmp` and moved into place only after verification. A partial download can never become the active model.
18. **Readiness gating.** The gateway MUST NOT accept inference requests on `/v1/*` until `llama-server` is ready.
19. **Checksum verification.** When a checksum is provided (`MODEL_SHA256`), downloads are verified against it. A corrupt or mismatched download is never activated, and the previous model remains untouched.
20. **No downloads at build time.** The model must not be downloaded during `docker build`; it is provisioned at container startup.

### 6.5 Inference API (`/v1/*`)

21. **OpenAI-compatible model list.** `GET /v1/models` returns the currently loaded model.
22. **OpenAI-compatible chat completions.** `POST /v1/chat/completions` is the primary inference endpoint and is forwarded to `http://127.0.0.1:8000/v1/chat/completions`.
23. **Reverse-proxied inference.** The gateway forwards `/v1/*` to `llama-server` via `node http-proxy`, preserving OpenAI semantics end to end.
24. **Streaming required.** `stream: true` requests MUST be forwarded from `llama-server` through the gateway to the client without buffering the entire response. SSE/HTTP streaming as required by `llama-server` / OpenAI-compatible clients is supported.
25. **Native backend.** `llama-server` provides the OpenAI-compatible implementation that the gateway proxies; there is no duplicate inference implementation.

### 6.6 Control API (`/api/*`)

26. **Liveness and status.** `GET /health` returns gateway liveness; `GET /api/status` returns gateway/llama/model status and model-loaded flags; `GET /api/model` returns the installed model metadata.
27. **Operations surface.** `POST /api/model/update`, `POST /api/model/restart`, and `POST /api/server/restart` expose admin operations; `GET /api/system`, `GET /api/metrics`, `GET /api/logs`, and `GET /api/requests` expose operational state (the last returns the inference request lifecycle ring, §6.12).
28. **One update mechanism.** Gateway-driven model updates invoke the same atomic model-management mechanism as `scripts/update-model.sh` (staging, verification, swap, reload, cleanup).
29. **Bounded logs.** The gateway keeps a bounded in-memory log ring; `GET /api/logs` and the live log feed draw from it.

### 6.7 Authentication & security

30. **Two credentials.** Two separate keys with different permission levels: an inference API key (scope `/v1/*`) and an admin API key (scope `/api/*`, `/ws`, and the control center). Control endpoints such as restart/update require the stronger admin authorization, which ordinary inference requests never get.
31. **No credential leakage.** Credentials are validated at the gateway and stripped before forwarding. They are never sent to `llama-server`.
32. **Request validation.** The gateway validates requests, limits request body size, avoids exposing internal filesystem paths, and exposes no arbitrary command execution through control endpoints.
33. **No prompt/response logging by default.** Complete prompts and generated responses are never logged by default — this rule is preserved for the entire system.
34. **Only one exposed port.** On the Pi, only `8080/tcp` (gateway) is exposed. `8000/tcp` (`llama-server`) is never exposed to the network.

### 6.8 Observability

35. **System metrics.** The gateway publishes CPU, RAM, temperature, disk, and inference throughput (`tok/s`) metrics.
36. **Logging categories.** Logs clearly identify: gateway startup, llama startup, model loading, model download, model update, model validation, health status, request errors, and shutdown.
37. **Request lifecycle.** Inference request events (started / completed / error) are observable, including throughput and duration.

### 6.9 Operations & reliability

38. **Process supervision and signals.** The gateway manages/starts `llama-server` as a child process with reliable supervision and proper shutdown handling. The container MUST handle `SIGTERM` and `SIGINT` cleanly (stop accepting, drain, terminate `llama-server`, exit).
39. **Restart policy.** Docker Compose uses `restart: unless-stopped`. The system recovers automatically after Pi reboot, Docker restart, and container crash. If `llama-server` crashes, the gateway detects it, attempts a restart, runs a health check, and reports success or unhealthy.
40. **Failure recovery.** A missing model triggers automatic download at startup. A corrupt model is reported as a failure and must not silently overwrite a known-good model.

### 6.10 Web Control Center

41. **Web Control Center**
The system MUST provide a browser-based control center.

Frontend:
- Single-file `index.html` (vanilla HTML/CSS/JS, no build step), following the established `rules-site/index.html` design pattern
- Served by the Node/Express gateway

The control center MUST provide:

- Gateway status
- llama-server status
- Model information
- CPU usage
- RAM usage
- Temperature
- Inference throughput
- Live logs
- Model update controls
- Server restart controls
- Model restart controls
- Test chat interface

The frontend communicates only with the Node/Express gateway.

The frontend MUST NOT communicate directly with llama-server.

Real-time status should use WebSockets.

The frontend should not have direct filesystem access.

Model update operations must invoke the gateway API, which invokes the existing model-management mechanism.

### 6.11 WebSocket API

42. **WebSocket API**
WebSocket endpoint:

```
/ws
```

Events:

```
system.metrics
llama.status
gateway.status
model.status
model.update
request.started
request.completed
request.error
log
```

### 6.12 Control Center v2 (UI plan)

43. **Inference request ring.** The gateway keeps a bounded, in-memory ring of inference
    request lifecycle records (`started` / `completed` / `error`). Each record carries:
    request id, path, model, `startedAt`, `durationMs`, `status`, and — when determinable —
    numeric token counts (`promptTokens`, `completionTokens`, `totalTokens`) and
    `tokensPerSecond`, plus an optional error message. These are intentional telemetry
    records and never contain prompt or response content (preserves §6.7 #33).
44. **Token accounting without buffering.** Token counts come from two numeric-only
    sources and are never parsed from content. When the proxied response carries a
    `usage` field (JSON responses, and OpenAI-style SSE final chunks when the server
    emits one) the counts are read by sniffing the passthrough writes for numeric
    fields only. Streaming responses stay fully unbuffered (§6.5 #24). llama-server
    does not emit `usage` in streaming chunks; for streams the counts are taken from
    llama-server's own per-task `slot print_timing` accounting on stderr (the
    `prompt eval time`, `eval time` and `total time` token figures), attributed to the
    in-flight request. Response `usage` wins over llama timing when both are present.
    Unknown counts render as `—` in the table.
45. **Requests surface.** `GET /api/requests` (admin key) returns the ring; `request.*`
    events (§6.11) are pushed over `/ws` as requests move `started → completed | error`.
46. **Streams table.** The control center shows a bounded table of inference requests —
    time, request id, status, tokens (prompt/completion/total), tok/s, duration — newest
    first, backfilled from `GET /api/requests` and updated live from `request.*` events.
    The `tok/s` value is encoded on a perceptually-uniform Viridis ramp (slow → fast).
47. **Playground conversation window.** The control center provides a multi-turn chat
    playground (§9.4) that exercises the same `/v1/chat/completions` path as OpenCode and
    renders the conversation in a single window (user/assistant bubbles) with Send + Stop
    and streaming readout. At `LLAMA_PARALLEL=1` only one inference can be in flight;
    concurrent sends surface llama-server's busy handling.
48. **Theme toggle.** The control center offers a small palette toggle: a neutral dark
    theme (default) and a subtle Viridis-tinted dark variant; the choice is persisted in
    `localStorage`.
49. **Typography.** The monospace face is **JetBrains Mono Nerd Font** when present on the
    client, then **JetBrains Mono** (web fallback), then the system mono stack.
50. **Layout hygiene.** The single-file UI avoids text overlap: flex rows gain
    `gap`/`wrap`/`min-width:0` with `overflow-wrap:anywhere` on values; long status values
    render as discrete chips or table cells instead of raw JSON blobs; long-form areas
    scroll within their cards.

## 7. HTTP API Reference

### 7.1 Control API (`/api/*`) — admin key

| Method | Path                 | Description                                |
|--------|----------------------|--------------------------------------------|
| GET    | `/health`            | Gateway liveness (no auth)                 |
| GET    | `/api/status`        | Aggregated system + model + service status |
| GET    | `/api/model`         | Loaded model metadata                      |
| GET    | `/api/system`        | CPU / RAM / temperature / disk             |
| GET    | `/api/metrics`       | Current metrics snapshot (incl. `tok/s`)   |
| GET    | `/api/logs`          | Recent log entries                         |
| GET    | `/api/requests`      | Recent inference request lifecycle records |
| POST   | `/api/model/update`  | Download & atomically swap a model         |
| POST   | `/api/model/restart` | Reload `llama-server` with current model   |
| POST   | `/api/server/restart`| Restart the gateway service                |

### 7.2 Inference API (`/v1/*`) — inference key

| Method | Path                    | Description                            |
|--------|-------------------------|----------------------------------------|
| GET    | `/v1/models`            | OpenAI-compatible model list           |
| POST   | `/v1/chat/completions`  | OpenAI-compatible chat completions     |

### 7.3 Realtime (`/ws`) — admin key

| Method | Path | Description                       |
|--------|------|-----------------------------------|
| WS     | `/ws`| Server-pushed realtime events     |

### 7.4 Example responses

`GET /health`

```json
{
  "status": "ok"
}
```

`GET /api/status`

```json
{
  "gateway": "online",
  "llama": "online",
  "model": "Qwen3-1.7B",
  "modelLoaded": true
}
```

`GET /api/model`

```json
{
  "name": "Qwen3-1.7B",
  "file": "current.gguf",
  "quantization": "Q8_0",
  "installed": true
}
```

## 8. WebSocket Events

All events are JSON objects with at least a `type` and a `timestamp`.

| Event                | Payload (besides `type`, `timestamp`)                      |
|----------------------|------------------------------------------------------------|
| `system.metrics`     | `cpu`, `memory`, `temperature`, `tokensPerSecond`          |
| `llama.status`       | `status`                                                   |
| `gateway.status`     | `status`                                                   |
| `model.status`       | `status`                                                   |
| `model.update`       | `status` (`downloading` / `verified` / `swapping` / `done` / `error`), `progress` |
| `request.started`    | `id`, `path`, `model`, `startedAt`                        |
| `request.completed`  | `id`, `model`, `status`, `durationMs`, `promptTokens`, `completionTokens`, `totalTokens`, `tokensPerSecond` |
| `request.error`      | `id`, `model`, `status`, `startedAt`, `error`             |
| `log`                | `level`, `message`                                         |

Example — metrics:

```json
{
  "type": "system.metrics",
  "timestamp": 1788300000000,
  "cpu": 72,
  "memory": 61,
  "temperature": 62,
  "tokensPerSecond": 18.4
}
```

Example — llama status:

```json
{
  "type": "llama.status",
  "status": "ready"
}
```

Example — model update progress:

```json
{
  "type": "model.update",
  "status": "downloading",
  "progress": 67
}
```

The `system.metrics` event is pushed periodically so the frontend never needs to poll.

## 9. Control Center UI

Single-file `index.html` (`gateway/public/index.html`), vanilla HTML/CSS/JS, clean design consistent with the existing `rules-site/index.html` project — no framework, no build tooling, hostable/servable by the gateway directly.

### 9.1 Dashboard

- Header: product name + overall status indicator (Online/Offline).
- Model card: model name, quantization, file size, inference throughput (`tok/s`), context size, CPU load.
- System card: CPU, RAM, temperature bars.
- Services card: `llama-server`, Gateway, Model — each with a running/stopped indicator.

### 9.2 Model page

Shows: model name, parameter count, quantization, GGUF filename, file size, SHA256, installed timestamp, download URL, context size, `llama-server` arguments, and model loading status.

Controls:

- **Restart** — reload the current model.
- **Update Model** — enter a model URL, then **Download & Update**. The UI calls the gateway API; the gateway runs the atomic model-management mechanism.

### 9.3 Live Logs

- Live log viewer with a **Clear** button.
- Renders the `log` WebSocket events and the bounded ring buffer from `GET /api/logs`.
- Preserves the no-prompt/no-response logging rule: prompts and responses never appear here by default.

### 9.4 Playground

- Test chat interface that uses the same `/v1/chat/completions` API as OpenCode — testing the actual production inference path.
- Requires the inference credential (**Inference API key**, stored in the browser's `localStorage` alongside the admin key); messages are not persisted by default.
- One multi-turn conversation window (user bubbles right, assistant left), with Send + Stop (AbortController); SSE tokens stream into the active assistant bubble.
- Every exchange appears in the Streams table (§9.5) via `request.*` events. At `LLAMA_PARALLEL=1`, one conversation at a time; an in-flight request surfaces llama-server's busy/503 behavior.

### 9.5 Inference streams

A table of recent `/v1/*` inference requests, newest first (bounded, ~20 rows):

| Time | Request | Status | Tokens (P/C/T) | tok/s | Duration |
|------|---------|--------|----------------|-------|----------|

- Backfilled from `GET /api/requests` on load; live rows are prepended from `request.started` / `request.completed` / `request.error` WebSocket events.
- The `tok/s` cell is tinted on a Viridis ramp (slow → fast, `#440154` → `#fde725`); rows with no token data show `—`.
- A small "N active" counter in the card heading tracks streams that are `started` but not yet done.

### 9.6 Theme & typography

- **Theme toggle** in the header: `Dark` (default) / `Viridis`. The Viridis variant keeps a neutral dark base and applies the palette subtly — Viridis-tinted surfaces and borders, a Viridis accent (`#5ec962`), and a Viridis progress gradient (`#440154 → #21918c → #fde725`). Persisted in `localStorage`.
- **Monospace:** `"JetBrainsMono Nerd Font"` first, then `"JetBrains Mono"` (web fallback), then the system mono stack. Sans faces keep the established system stack.

### 9.7 Layout fixes (no text overlap)

- Flex `.row`s get `gap`, `wrap`, and `min-width:0`; values wrap with `overflow-wrap:anywhere` so long labels and values never collide.
- Raw `JSON.stringify` status blobs are replaced by discrete status chips and structured rows.
- The header and cards wrap on narrow widths; `pre` and table regions scroll inside their cards.

## 10. Model Lifecycle & Data Management

### 10.1 Active model layout

```
/opt/qwen-model/            ← host (mounted into container at /models)
└── current.gguf            ← the single active model

/opt/qwen-model/.download/  ← staging area, present only during downloads/updates
└── current.gguf.tmp
```

The Docker image MUST NOT contain the GGUF model. Normally there is exactly one large GGUF model on disk.

### 10.2 Startup sequencing (entrypoint)

1. Start container.
2. Ensure `/models` exists.
3. Check whether `current.gguf` exists.
4. If the model exists → continue.
5. If the model does not exist → download the model (via `ensure-model.sh` staging flow).
6. Verify the download (checksum when `MODEL_SHA256` is provided).
7. Start `llama-server` (`--model /models/current.gguf --host 127.0.0.1 --port 8000` plus configured flags).
8. Wait for `llama-server` health.
9. Start the Node gateway.
10. Gateway becomes available. Inference is refused until step 8 succeeds.

### 10.3 First-run download (`scripts/ensure-model.sh`)

Behavior:

```
if /models/current.gguf exists
    use it
else
    download to /models/.download/current.gguf.tmp
    verify download
    atomically install as /models/current.gguf
```

The download must not write directly to `/models/current.gguf`. Only after a successful, verified download is the temp file moved into place — this prevents partial downloads from becoming the active model.

### 10.4 Model update

Two entry points, one mechanism:

- **Host:** `./scripts/update-model.sh <model-url>` (URL optional; defaults to `MODEL_URL`).
- **Control center / gateway API:** `POST /api/model/update`.

Update process:

1. Determine the new model URL.
2. Create the temporary download directory (`.download/`).
3. Download the new GGUF to the staging path.
4. Verify the download.
5. Verify the checksum if available (`MODEL_SHA256`).
6. Stop `llama-server`.
7. Replace the active model atomically.
8. Remove temporary files.
9. Restart the service / reload `llama-server`.
10. Wait for `llama-server` health.
11. Verify gateway health.

Progress is streamed over `/ws` (`model.update` events).

### 10.5 Failed update behavior

- If downloading fails → `current.gguf` MUST remain untouched.
- If checksum validation fails → `current.gguf` MUST remain untouched.
- If the new model cannot be loaded → restore the previous model if possible, restart the gateway, and report the failure clearly.
- The update process MUST NOT leave multiple large model files permanently on disk.

### 10.6 Disk management & cleanup

- Maintain a single `current.gguf` plus a transient `.download/` area.
- After success or failure, `.download/` MUST be cleaned.
- `scripts/cleanup.sh` removes only known temporary files and artifacts. It MUST NOT blindly run `rm -rf /opt/qwen-model/*`, and it must never delete the working model unless explicitly told to.

## 11. Environment Configuration

Configuration is controlled through environment variables (`.env`, loaded by Docker Compose). Secrets are never committed to Git.

| Variable                | Description                                   | Default                     |
|-------------------------|-----------------------------------------------|-----------------------------|
| `GATEWAY_HOST`          | Gateway bind address                          | `0.0.0.0`                   |
| `GATEWAY_PORT`          | Gateway listen port                           | `8080`                      |
| `INFERENCE_API_KEY`     | Key for `/v1/*`                               | (required)                  |
| `ADMIN_API_KEY`         | Key for `/api/*` and `/ws`                    | (required)                  |
| `LLAMA_HOST`            | `llama-server` bind address                   | `127.0.0.1`                 |
| `LLAMA_PORT`            | `llama-server` port                           | `8000`                      |
| `LLAMA_BIN`             | Path to `llama-server` inside the container   | `/opt/llama/llama-server`   |
| `LLAMA_CONTEXT_SIZE`    | Context window                                | `8192`                      |
| `LLAMA_THREADS`         | CPU threads (empty = llama decides)           | (unset)                     |
| `LLAMA_BATCH_SIZE`      | Prompt batch size                             | (unset)                     |
| `LLAMA_PARALLEL`        | Parallel sequences                            | (unset)                     |
| `LLAMA_EXTRA_ARGS`      | Additional `llama-server` flags               | (unset)                     |
| `MODEL_NAME`            | Model display name                            | `Qwen3-1.7B`                |
| `MODEL_URL`             | Download URL for the GGUF (configurable)      | (required)                  |
| `MODEL_FILE`            | Active filename inside `/models`              | `current.gguf`              |
| `MODEL_SHA256`          | Expected SHA-256 of the model (optional)      | (unset)                     |
| `MODEL_DIR`             | Host model directory                          | `/opt/qwen-model`           |
| `AUTO_UPDATE_MODEL`     | Automatic model updates (must be opt-in)      | `false`                     |
| `AUTO_UPDATE_INTERVAL`  | Update check interval when auto-update is on  | `24h`                       |

Notes:

- The exact GGUF URL (default: `Qwen/Qwen3-1.7B-GGUF`, `Qwen3-1.7B-Q8_0.gguf`) is configurable rather than hard-coded into application logic.
- Performance settings (`LLAMA_CONTEXT_SIZE`, `LLAMA_THREADS`, `LLAMA_BATCH_SIZE`, `LLAMA_PARALLEL`, `LLAMA_EXTRA_ARGS`) are environment-driven and should not be hard-coded until the target Qwen variant is selected and benchmarked.
- The original single `GATEWAY_API_KEY` concept from early drafts maps to the inference key (`INFERENCE_API_KEY`). The admin key is the additional stronger credential introduced for the control surface.

## 12. Process Model, Signals & Restart Policy

- **Docker process model.** The container runs the Node gateway, which manages/starts `llama-server` as a child process:
  ```
  Node Gateway
       │
       └── manages/starts
               │
               ▼
         llama-server
  ```
- **Supervision.** Node provides reliable process supervision: start, monitor (health), restart on failure, and proper shutdown handling.
- **Signals.** The container MUST handle `SIGTERM` and `SIGINT` cleanly: stop accepting new requests, drain in-flight inference, terminate `llama-server`, and exit.
- **Entrypoint.** `scripts/entrypoint.sh` handles signal forwarding, runs `ensure-model.sh` (first-run provisioning), then `exec`s the Node gateway.
- **Restart policy.** Compose sets `restart: unless-stopped`, so the system recovers after Pi reboot, Docker restart, or container crash.

## 13. Health Checks & Readiness

- **Liveness.** `GET /health` is exposed (unauthenticated) and reports `{"status":"ok"}`.
- **Internal monitoring.** The gateway continuously monitors `llama-server` availability; startup waits until `llama-server` is ready before serving inference.
- **Docker healthcheck.** `scripts/healthcheck.sh` backs the Docker healthcheck and distinguishes *container running* from *model actually ready*.
- **Readiness gating.** Until `llama-server` reports ready, `/v1/*` requests are rejected and the status surfaces report the unready state.

## 14. Logging

Logs clearly identify:

- gateway startup
- llama startup
- model loading
- model download
- model update
- model validation
- health status
- request errors
- shutdown

Complete prompts and generated responses are NOT logged by default.

Example:

```
[INFO] Gateway listening on 0.0.0.0:8080
[INFO] Starting llama-server
[INFO] Waiting for llama-server
[INFO] llama-server ready
[INFO] Model: Qwen3-1.7B
[INFO] Gateway ready
```

Logs are captured in a bounded in-memory ring (`GET /api/logs`) and streamed live over `/ws` (`log` events).

## 15. Security

- **Only one exposed port.** The Pi exposes only `8080/tcp` (gateway). `8000/tcp` (`llama-server`) is never exposed.
- **Two-key authentication.** Inference key for `/v1/*`, admin key for `/api/*` and `/ws`. Control endpoints require the stronger admin authorization.
- **Credential hygiene.** Credentials are validated at the gateway and stripped before forwarding; neither key is ever sent to `llama-server`.
- **Request validation.** The gateway limits request body size, validates inputs, and avoids exposing internal filesystem paths.
- **No command execution.** Control endpoints expose no arbitrary command execution — they invoke the bounded model-management, restart, and shutdown mechanisms only.
- **Logging discipline.** Prompts and generated responses are never logged by default.
- **Filesystem isolation.** The model volume (`/opt/qwen-model:/models`) and the llama runtime mount serve the gateway only. The frontend has no direct filesystem access.
- **Secrets.** `INFERENCE_API_KEY` and `ADMIN_API_KEY` live in `.env`, which is never committed.

## 16. Backup

- **Models are not backed up by default.** They can be downloaded again.
- **Configuration is backed up in Git:** `docker-compose.yml`, `Dockerfile`, `gateway/`, `scripts/`, `.env.example`.
- The real `.env` (secrets) is backed up separately if required.

## 17. Failure Recovery

- **`llama-server` crashes:** the gateway detects the failure → attempts a restart → runs a health check → success: continue; failure: report unhealthy (`/api/status`, `/ws`, dashboard).
- **Container crashes:** the Docker restart policy (`unless-stopped`) restarts it.
- **Model missing:** startup automatically downloads it.
- **Model corrupt:** the startup/update process reports failure and does not silently overwrite a known-good model.

## 18. Deployment & First Run

### 18.1 Compose topology

```
docker-compose.yml
└── gateway
      ├── Express            (REST control + OpenAI proxy + WS + static UI)
      ├── node http-proxy    (lightweight reverse proxy / ingress)
      └── llama-server       (127.0.0.1:8000, localhost-only)

ports:
  - "8080:8080"               # only exposed port

volumes:
  - /opt/qwen-model:/models   # model data (gateway only)
  - /opt/llama:/opt/llama:ro  # host-provisioned llama runtime (read-only)

restart: unless-stopped
healthcheck: scripts/healthcheck.sh
```

### 18.2 First deployment

```bash
git clone <repository>
cd opencode-pi

cp .env.example .env
# configure MODEL_URL, INFERENCE_API_KEY, ADMIN_API_KEY, and other settings

sudo mkdir -p /opt/qwen-model
sudo ./scripts/install.sh      # provision llama.cpp release into /opt/llama

docker compose build
docker compose up -d
```

The model is NOT downloaded during `docker build`. On the first container start, the gateway/entrypoint downloads, verifies, and atomically installs the model, then brings up `llama-server` and the gateway.

Check:

```bash
curl http://<PI-IP>:8080/health
```

Expected:

```json
{
  "status": "ok"
}
```

### 18.3 Model updates

- Host: `./scripts/update-model.sh <model-url>`.
- Control center: Model page → **Download & Update** (gateway API).

Both use the atomic mechanism in §10.4.

### 18.4 Cleanup

- `./scripts/cleanup.sh` removes known temporary artifacts only.

## 19. OpenCode Integration

The Arch laptop runs OpenCode.

- OpenCode connects to: `http://<PI-IP>:8080/v1`
- OpenCode MUST NOT connect directly to `http://192.168.1.50:8000`.
- The gateway is the stable API boundary.

Test from the Arch laptop:

```bash
curl http://<PI-IP>:8080/v1/models
```

```bash
curl http://<PI-IP>:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3-1.7B",
    "messages": [
      {
        "role": "user",
        "content": "Hello"
      }
    ]
  }'
```

Streaming (`"stream": true`) must also be tested.

## 20. Acceptance Criteria

### Installation

- `docker compose build` succeeds on Raspberry Pi 5.
- `docker compose up -d` starts the service.
- The Docker image does not contain the GGUF model.
- A missing model is downloaded automatically on first start.
- The model is stored outside Docker (`/opt/qwen-model`).
- The model survives container recreation.

### Gateway

- The gateway listens on the configured port (`0.0.0.0:8080`).
- `GET /health` works.
- `GET /api/status` works.
- `GET /api/model` works.
- `/v1/chat/completions` proxies correctly.
- Streaming works.
- OpenCode can connect.

### llama-server

- `llama-server` starts automatically.
- `llama-server` binds only to localhost inside the container.
- `llama-server` is not exposed directly to the LAN.
- The gateway waits for `llama-server` readiness before serving inference.

### Model updates

- A new model downloads to a temporary location.
- The existing model remains untouched during download.
- A failed download leaves the existing model usable.
- Checksums can be verified (`MODEL_SHA256`).
- A successful update replaces the active model.
- The old model is removed.
- Temporary download files are removed.
- The service restarts using the new model.

### Reliability

- A Pi reboot automatically recovers the service.
- A container restart automatically recovers the service.
- `llama-server` failure is detected.
- Logs identify startup/update failures.
- No unnecessary model copies remain on disk.

### Control Center

- The streams table shows bounded inference-request rows (time, id, status, token counts, tok/s, duration) fed by `GET /api/requests` and live `request.*` WebSocket events.
- The Playground streams a multi-turn conversation through `/v1/chat/completions` and renders the reply incrementally.
- The Viridis theme toggle switches and persists; JetBrains Mono Nerd Font is used when the client has it, with web fallback.
- No UI text overlaps: labels and values stay on separate flex rows/wrapped lines, and no raw JSON blobs render in status rows.
- Request records never contain prompt or response content.

## 21. Design Principles

The implementation follows these principles:

- Model is data, not application code.
- The Docker image must remain small.
- Only one large model should normally exist on disk.
- Never destroy the working model before the replacement is verified.
- The gateway is the only network-facing inference endpoint.
- `llama-server` stays internal to the container.
- Configuration belongs in environment variables.
- Model updates must be atomic.
- Failed downloads must be recoverable.
- OpenCode should depend only on the stable gateway API.
- The system should be reproducible from Docker Compose.
- Pi-specific performance tuning should remain configurable.

## 22. Future Scope (explicitly out of the initial build)

Vendor-neutral possibilities for later iterations:

- **Model version dashboard** (current vs available).
- **Automatic model discovery** — a model registry/repository → check current version → download → verify → activate → restart; never assume a newer file is valid merely because it downloaded.
- **Scheduled checks** — one check per day, strictly opt-in (`AUTO_UPDATE_MODEL=false` default, `AUTO_UPDATE_INTERVAL=24h`).
- **Rollback to the previous model** on update failure or by user request.
- **Model profiles** (named model/config presets).
- **Multiple model support** and hot-switching from the control center.
- **Larger Qwen quants** — the model and the control plane are independent, so upgrading later does not require a UI redesign.
- **Historical metrics persistence** for trending and capacity planning.
- **Rate limiting** and **request queueing**.
- **Multiple inference workers** and GPU/accelerator detection.
- **Automatic llama.cpp parameter tuning**.
- **User accounts & role-based access** beyond a single admin credential.
- **Remote access** beyond the LAN via SSH, Tailscale, WireGuard, or a deliberate authenticated gateway boundary.
- **LAN device authentication.**

Note: the original spec listed the *web control center, model dashboard, CPU/RAM/temperature monitoring, token/sec monitoring, and request metrics* as future enhancements. These are now in scope for the initial build via the control center (§9) and WebSocket API (§6.11, §8).

## 23. Open Questions

Resolved at build time:

- **Model:** Qwen3-1.7B, Q8_0 (`Qwen/Qwen3-1.7B-GGUF`, Apache-2.0, 1.83 GB).
- **Repository/source URL:** `https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf` (public, no auth required).
- **Checksum:** SHA-256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a` published by HuggingFace LFS.
- **Expected context length:** `8192` (default).
- **Target tokens/sec:** ~8–10 on Pi 5 (measured ~8.7 at 4 threads on Cortex-A76-class); `LLAMA_THREADS=4`.
- **Pi 5 RAM:** 16 GB.
- **LAN key policy:** keys required by default; inference `/v1/*` + admin `/api/*` + `/ws`. No no-key mode.
- **Automatic updates:** opt-in, default `false`.
- Where additional runtime artifacts live on the host (e.g. `/opt/llama` assumed).
- Real-time metric sampling interval (proposal: 2–5 s for `system.metrics`).