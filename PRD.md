# opencode-pi — Product Requirements Document

- **Product:** opencode-pi
- **Status:** Draft v0.5 (integrates original product spec §1–40, control-plane additions §41–42, Control Center v2 §6.12 + §9.4–9.7, the analytics & risk layer refresh §6.13 #56–69, §7.1/§7.3/§7.4, §8, §9.9, §11, §18.1, §20, and the 4-bit model-swap runbook §10.7)
- **Date:** 2026-09-06
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
48. **Theme set.** The control center offers a cycling palette toggle through four themes —
    **Dark** (default), **Viridis** (subtle Viridis-tinted dark), **Whale** (cool ocean
    blues), and **Rosé Pine** — each overriding the same core CSS token set; the choice is
    persisted in `localStorage`.
49. **Typography.** The monospace face is **JetBrains Mono Nerd Font** when present on the
    client, then **JetBrains Mono** (web fallback), then the system mono stack.
50. **Layout hygiene.** The single-file UI avoids text overlap: flex rows gain
    `gap`/`wrap`/`min-width:0` with `overflow-wrap:anywhere` on values; long status values
    render as discrete chips or table cells instead of raw JSON blobs; long-form areas
    scroll within their cards.
51. **System metrics table.** The control center renders a System card with CPU %, Memory %,
    temperature, disk-used %, token rate, and a rolling **API calls per minute** (start
    requests in the last 60s), backfilled from `GET /api/system` and updated live from
    `system.metrics` WebSocket events. CPU and memory are colored on the Viridis load ramp.
52. **Host details card.** A Host card (fastfetch-style, stats table) shows instance details:
    OS pretty-name, Host/hostname, Kernel, Arch, Pi hardware Model line, CPU model + core
    count, total memory, uptime (`Xd Xh Xm`), and the local IPv4. Sourced from
    `GET /api/system/host` (admin key). Because the UI reads through the gateway container,
    these are the container-visible host values — the real Pi CPU/cores/kernel/uptime/memory
    and hardware model; OS and hostname reflect the container image.
53. **Log window.** Realtime events render as a scrollable, color-tagged log in the events
    card: each line shows `[time] tag  message`, auto-scrolls when the view is at the bottom,
    is capped at 300 lines, and has a Clear button. Error/warn `log` events and request
    failures are colored distinctly.
54. **Error drill-down.** In the streams table an `error` status is clickable and toggles an
    inline `reason:` row showing the error message for that request. Clicking any stream row
    scrolls the log window to that request's related entries and briefly flashes them, so the
    request's activity is easy to trace in the realtime log.
55. **Shell, navigation & theme.** The control center is a single page with a fixed left
    sidebar (brand mark + one link per section, each with a colored marker matching its card
    accent; the active section highlights via scrollspy; on narrow screens the sidebar
    collapses to a compact rail) and a fixed bottom status bar: live gateway / llama / model
    chips, CPU %, memory %, token rate, API calls/min, a 1-second clock, and the theme toggle.
    Cards carry per-module accent colors (Connection, System, Model, Host, Playground,
    Streams, Events) on their top border and card title, with a subtle glow/hover/pulse
    treatment so the UI reads as alive. The topbar title carries a subtitle tag naming the
    app (e.g. "opencode-pi gateway"). The theme set (§6.12 #48) is preserved.

### 6.13 Analytics & risk layer (ML plan — revised 2026-09-06)

The layer is a separate Python microservice (`analytics`, port `8081`) that **serves live**
ML results. It is fed by the gateway via a webhook, re-scores every new window against an
adaptive EWMA + PCA reference, labels windows via a top-3 principal-component ±1.5σ rule,
detects drift over historic windows, searches two lookalike embedding stores, and serves
everything live over the gateway as WS events and an SSE stream. All access is
gateway-proxied; `:8081` is never exposed to the LAN.

56. **Analytics microservice.** A separate Python process (`analytics`, port `8081`) consumes
    gateway telemetry via a webhook and runs the ML layer: a TF-Lite neural net for risk/drift
    inference, PCA eigen-decomposition for the risk model, and windowed historic analysis. It
    is a sibling service in this repo (same Compose stack), runtime-decoupled from the gateway:
    the gateway never blocks inference on analytics availability. The numeric kernel is written
    to be portable to C++ later (well-specified math routines, transportable storage schema, no
    Python-only state in the hot path).
57. **Feature & context windows.** Numeric-only features roll into fixed windows
    (`ANALYTICS_FEATURE_WINDOW_SEC`, default 60s). The model consumes a **context window** —
    the last `ANALYTICS_CONTEXT_WINDOWS` windows per feature (default 12 ≈ up to 12 min) — as
    its input tensor. Windowed aggregates drive historic drift analysis; per-request features
    drive the live serving path.
58. **Ingest webhook.** The gateway pushes batched request records + window aggregates to
    `POST /v1/analytics/ingest` (shared secret `INGEST_SECRET`). Push cadence is deferred
    (TBD). When analytics is unreachable, batches queue in Redis with a bounded escrow and
    flush on reconnect — no loss, no backpressure on inference. Ingested records stay
    numeric-only, preserving §6.7 #33. Incoming webhook batches surface in the live log and
    `/api/logs` as `analytics.webhook` entries (batch size, record count, latency, auth result).
59. **Adaptive EWMA reference.** Reference statistics (per-feature mean/σ, PCA loadings)
    adapt with slow exponential decay (`ANALYTICS_EWMA_DECAY`) rather than being frozen, so
    risk reads as "drift from the recent norm". A manual re-fit endpoint is provided.
60. **PCA + label rule.** Eigen-decomposition yields up to `ANALYTICS_PCA_COMPONENTS` (default 6)
    principal components over the **current rolling context window**. Hotelling `T²` of
    standardized scores gives a supporting continuous probability (`F/χ²` tail). The risk
    **label** is driven by the **top 3** components' z-scores against the EWMA reference:
    **high risk** when any top-3 PC is `z ≤ −1.5 or z ≥ +1.5` (signed — both directions trip),
    **watch** when `ANALYTICS_PCA_WATCH_Z ≤ |z| < 1.5`, otherwise **normal**. Labels recompute
    live on each new window and double as the training target.
61. **Drift detection.** Feature-level PSI, KS/MMD on PC scores, and loading-vector shift,
    evaluated over historic stored windows and live on the latest window.
62. **SQLite vector/embedding store.** Each request and window is a row carrying its feature
    vector, `context` tensor, principal components, eigenvalues, per-feature loadings, and a
    learned numeric embedding (NN head). A second `sqlite-vec` index stores **semantic
    embeddings** (transformer embedder over a canonical, content-free numeric window encoding —
    never prompt/response/reasoning content). Both embedding stores support nearest-neighbor
    historic lookback ("which past windows looked like this?") and are **excluded from PCA/risk
    math**. The db file lives on an external mount (survives container recreation).
63. **Redis.** Full footprint: validated-key cache + per-key rate-limit counters, the analytics
    ingest escrow queue, and a shared live-score cache between gateway and analytics. Redis is
    **warehoused**: compose volume + appendonly persistence, with keys/types/TTL visible in the
    Control Center Warehouse view.
64. **TF-Lite neural net + in-app training.** A small model (context window → risk + drift
    probabilities) is served via TFLite inside the Python service. Training runs **in-app**: a
    compose service `analytics-train` (no exposed port) is startable from the UI and invoked by
    `analytics` via API; it trains/quantizes from the labeled window export and writes artifacts
    to `/opt/qwen-ml`; `analytics` hot-reloads new artifacts, so TFLite serving goes live once
    artifact #1 exists. Artifacts live on the host under `/opt/qwen-ml` and are mounted in —
    never baked into images.
65. **Live ML results in the UI (gateway fan-out + SSE).** Analytics POSTs latest scores/drift
    to a gateway endpoint, which broadcasts `analytics.risk` / `analytics.drift` (and
    `analytics.pca`, `training.*`, `pipeline.*`, `store.*`) over the existing
    admin-authenticated `/ws`. Analytics also exposes an SSE stream (`/v1/analytics/stream`,
    shared secret) that the gateway proxies as `GET /api/analytics/stream` (admin key) for
    EventSource clients. The Control Center gains Analytics, Connections, Pipelines,
    Warehouse, Documents, and How-to-use sections; historic analysis is admin-proxied via
    `/api/analytics/*`.
66. **Gateway-proxy-only access.** The analytics service binds internally; the UI and any
    external consumer (e.g. another project using Qwen) reach analytics data **only** through
    admin-proxied `/api/analytics/*` on the gateway `:8080`. Only `8080:8080` is published to
    the LAN; `:8081` is never exposed. The SQLite file is never shared as a raw network file.
    The gateway + analytics containers together are the source of truth.
67. **Live historic streaming.** A change-feed streams new window/request rows from the vector
    store to the ML layer (triggers a live re-score on every new window) and to the UI via
    `store.window` / `store.request` events and the SSE stream; historic and live data for the
    external Qwen project are served through the same gateway read API.
68. **Orchestrator UI.** The Control Center gains: a Dashboard with quick **Test connection** /
    **Sync now** buttons per connection; an **Analytics** card showing ML results plus ML
    service **compute time (ms)**, **temperature**, and ML process CPU/mem; a **Connections**
    section (gateway / analytics / redis / sqlite / webhook / external Qwen with endpoint
    details, health, mini metrics, add/edit metadata); a **Pipelines** section (training,
    webhook, and live WebSocket clients as pipelines with usable endpoints, events/sec, bytes,
    last-seen, status, and UI-registered new pipelines); a **Warehouse** section (SQLite
    schema/tables/columns/row counts/raw columns + Redis keys/types/TTL/memory); Logs
    (including incoming webhook entries); a **Documents** page; and a **How-to-use** page.
69. **Multivariate live updates.** Every analytics surface — risk label, PCA components and
    loadings, drift, lookalikes, warehouse counts, pipeline/connection metrics — updates live
    via the WebSocket bus and the SSE stream; the UI holds a live connection on both.

Feature set (numeric-only): per-request `log prompt/completion/total tokens`, `tok/s`,
`log durationMs`, error-binary; window `requestsPerMinute`, error rate, p95/p99 latency and
tok/s; system context at inference time (cpu %, mem %, temperature, disk %, thermal ramp).
Planned numeric additions: `timeToFirstToken`; Qwen3 thinking-share (pending explicit
approval — still never the content itself).

## 7. HTTP API Reference

### 7.1 Control API (`/api/*`) — admin key

| Method | Path                 | Description                                |
|--------|----------------------|--------------------------------------------|
| GET    | `/health`            | Gateway liveness (no auth)                 |
| GET    | `/api/status`        | Aggregated system + model + service status |
| GET    | `/api/model`         | Loaded model metadata                      |
| GET    | `/api/system`        | CPU / RAM / temperature / disk + `requestsPerMinute` |
| GET    | `/api/system/host`   | Host details (OS, kernel, arch, model, CPU, mem, uptime, IP) |
| GET    | `/api/metrics`       | Current metrics snapshot (`tok/s`, `requestsPerMinute`) |
| GET    | `/api/logs`          | Recent log entries                         |
| GET    | `/api/requests`      | Recent inference request lifecycle records |
| POST   | `/api/model/update`  | Download & atomically swap a model         |
| POST   | `/api/model/restart` | Reload `llama-server` with current model   |
| POST   | `/api/server/restart`| Restart the gateway service                |
| GET    | `/api/analytics/risk`| Latest risk score + label + PC components (proxied) |
| GET    | `/api/analytics/pca` | PCA snapshot: components, eigenvalues, per-feature loadings (proxied) |
| GET    | `/api/analytics/drift/historic` | Historic drift series (proxied)     |
| GET    | `/api/analytics/historic/lookalikes` | Nearest historic windows by embedding type (proxied) |
| GET    | `/api/analytics/training/export`     | Labeled training-data export (admin proxy to analytics) |
| POST   | `/api/analytics/training/start`      | Start/queue an in-app TFLite training job (proxy) |
| GET    | `/api/analytics/training/status`     | Training job status + progress (proxy) |
| POST   | `/api/analytics/rebaseline`          | Manual EWMA / PCA reference re-fit (proxy) |
| GET    | `/api/analytics/pipelines`           | Pipeline list (training, webhook, live WS clients) (proxy) |
| POST   | `/api/analytics/pipelines`           | Register a new pipeline (consumer/webhook) (proxy) |
| GET    | `/api/analytics/warehouse/sql`       | SQLite schema, tables, columns, row counts (proxy) |
| GET    | `/api/analytics/warehouse/redis`     | Redis key inventory (types / TTL / memory) (proxy) |
| GET    | `/api/analytics/stream`              | Live analytics SSE stream (admin key; proxied from `:8081`) |

### 7.2 Inference API (`/v1/*`) — inference key

| Method | Path                    | Description                            |
|--------|-------------------------|----------------------------------------|
| GET    | `/v1/models`            | OpenAI-compatible model list           |
| POST   | `/v1/chat/completions`  | OpenAI-compatible chat completions     |

### 7.3 Analytics API (`:8081/*`) — shared secret, internal to compose

| Method | Path                       | Description                               |
|--------|----------------------------|-------------------------------------------|
| POST   | `/v1/analytics/ingest`     | Gateway → analytics batched feature ingestion |
| POST   | `/v1/analytics/scores`     | Analytics → gateway live score push (fan-out trigger) |
| POST   | `/v1/analytics/rebaseline` | Manual EWMA / PCA reference re-fit        |
| GET    | `/v1/analytics/training/export` | Labeled JSONL/CSV training-data export    |
| GET    | `/v1/analytics/historic/windows` | Paged raw window + embedding records      |
| GET    | `/v1/analytics/pca`        | PCA snapshot (components, eigenvalues, per-feature loadings) |
| GET    | `/v1/analytics/lookalikes` | Nearest historic windows by embedding type (learned / semantic) |
| POST   | `/v1/analytics/training/start` | Start an in-app TFLite training job     |
| GET    | `/v1/analytics/training/status` | Training job status + progress          |
| GET    | `/v1/analytics/pipelines`  | Pipeline list (training, webhook, consumers) |
| POST   | `/v1/analytics/pipelines`  | Register a new pipeline (consumer/webhook) |
| GET    | `/v1/analytics/warehouse/sql` | SQLite schema, tables, columns, row counts |
| GET    | `/v1/analytics/warehouse/redis` | Redis key inventory (types / TTL / memory) |
| GET    | `/v1/analytics/stream`     | Live SSE stream (shared secret — proxied by the gateway) |
| GET    | `/v1/analytics/health`     | Analytics liveness (no auth)              |

### 7.4 Realtime (`/ws`) — admin key

| Method  | Path | Description                       |
|---------|------|-----------------------------------|
| WS      | `/ws`| Server-pushed realtime events (WebSocket) |
| SSE (GET) | `/api/analytics/stream` | Live analytics events (EventSource; proxied from `:8081`) |

### 7.5 Example responses

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

## 8. Realtime Events (WebSocket + SSE)

All events are JSON objects with at least a `type` and a `timestamp`. They are delivered
over the admin-authenticated WebSocket `/ws`. The analytics events (`analytics.*`,
`training.*`, `pipeline.*`, `store.*`, `analytics.webhook`) are additionally served on the
SSE stream `GET /api/analytics/stream` (admin key, EventSource-compatible), so the UI and
the external Qwen project can hold a live connection without WebSockets.

| Event                | Payload (besides `type`, `timestamp`)                      |
|----------------------|------------------------------------------------------------|
| `system.metrics`     | `cpu`, `memory`, `temperature`, `tokensPerSecond`, `requestsPerMinute` |
| `llama.status`       | `status`                                                   |
| `gateway.status`     | `status`                                                   |
| `model.status`       | `status`                                                   |
| `model.update`       | `status` (`downloading` / `verified` / `swapping` / `done` / `error`), `progress` |
| `request.started`    | `id`, `path`, `model`, `startedAt`                        |
| `request.completed`  | `id`, `model`, `status`, `durationMs`, `promptTokens`, `completionTokens`, `totalTokens`, `tokensPerSecond` |
| `request.error`      | `id`, `model`, `status`, `startedAt`, `error`             |
| `analytics.risk`     | `label` (`normal` / `watch` / `high`), `t2`, `pValue`, `top3`: `[{i, z, signed}]`, `timestamp` |
| `analytics.pca`      | `components`: up to 6 `[{i, eigenvalue, loadings: {feature: value}}]`, `k`, `windowStart` |
| `analytics.drift`    | `features` (`psi`), `ks`, `mmd`, `loadingShift`, `windowStart` |
| `training.started`   | `jobId`, `artifactTarget`                                  |
| `training.progress`  | `jobId`, `phase`, `percent`                                |
| `training.done`      | `jobId`, `artifact`, `sizeBytes`, `quantization`           |
| `training.error`     | `jobId`, `error`                                           |
| `pipeline.*`         | `id`, `kind` (`webhook` / `ws` / `consumer` / `training`), `status`, `metrics` (`eventsPerSecond`, `bytes`, `lastSeen`) |
| `store.window`       | `id`, `windowStart`, `features`, `context`, `pcs`, `label`, `embeddings` |
| `store.request`      | `id`, `startedAt`, `features`, `embedding`, `error`        |
| `analytics.webhook`  | `batchSize`, `records`, `latencyMs`, `authOk`              |
| `log`                | `level`, `message`                                         |

Example — metrics:

```json
{
  "type": "system.metrics",
  "timestamp": 1788300000000,
  "cpu": 72,
  "memory": 61,
  "temperature": 62,
  "tokensPerSecond": 18.4,
  "requestsPerMinute": 5
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

Example — analytics risk (SSE and WS share this payload):

```json
{
  "type": "analytics.risk",
  "timestamp": 1788300600000,
  "label": "high",
  "t2": 9.41,
  "pValue": 0.0082,
  "top3": [
    { "i": 0, "z": 2.06, "signed": 2.06 },
    { "i": 1, "z": -1.71, "signed": -1.71 },
    { "i": 2, "z": 0.62, "signed": 0.62 }
  ]
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
- An `error` status is clickable (§6.12 #54): clicking toggles an inline row showing the request's error reason.
- Clicking any stream row (§6.12 #54) scrolls the log window to that request's entries and flashes them.

### 9.6 Theme & typography

- **Theme toggle** in the header cycles through four themes: `Dark` (default) / `Viridis` /
  `Whale` / `Rosé Pine`. The Viridis variant keeps a neutral dark base and applies the palette
  subtly — Viridis-tinted surfaces and borders, a Viridis accent (`#5ec962`), and a Viridis
  progress gradient (`#440154 → #21918c → #fde725`). Whale uses cool ocean blues; Rosé Pine
  uses its rose/pine/foam/iris palette. Each theme overrides the same core token set, and the
  choice is persisted in `localStorage`.
- **Monospace:** `"JetBrainsMono Nerd Font"` first, then `"JetBrains Mono"` (web fallback), then the system mono stack. Sans faces keep the established system stack.

### 9.7 Layout fixes (no text overlap)

- Flex `.row`s get `gap`, `wrap`, and `min-width:0`; values wrap with `overflow-wrap:anywhere` so long labels and values never collide.
- Raw `JSON.stringify` status blobs are replaced by discrete status chips and structured rows.
- The header and cards wrap on narrow widths; `pre` and table regions scroll inside their cards.

### 9.8 Module layout

The page is wrapped in a shell: a fixed left sidebar (brand + section links with accent
markers, scrollspy highlight, collapsing to a rail on narrow screens) and a fixed bottom
status bar. On wide screens the dashboard is a 3-column grid laid out top-to-bottom:

1. **Metric row** — `Connection` · `System` · `Model` (equal-height cards).
2. **Host | Playground** — the Host details card (§6.12 #52) beside the Playground conversation window (§9.4).
3. **Inference streams** — full-width, placed immediately above the log.
4. **Realtime events** — the full-width log window (§6.12 #53) at the bottom.

Each card is tinted with its own accent (top border + card title). All cards fill their grid
tracks and collapse to a single column on narrow screens, where the sidebar becomes a compact
icon rail.

### 9.9 Analytics & orchestrator UI

The Control Center gains an orchestration layer for the analytics & risk layer. All of it
reads through the gateway (`/api/analytics/*` admin proxies, `/ws`, and the SSE stream
`/api/analytics/stream`) — the browser never talks to `:8081` directly. Every surface
updates live via WS + SSE.

- **Dashboard quick sync.** Every connection card (gateway, llama, analytics, redis,
  sqlite, webhook, external Qwen client) carries **Test connection** (ping + latency/OK)
  and **Sync now** (pull the latest snapshot on demand) buttons.
- **Analytics card.** ML results: current risk label (normal / watch / high), supporting
  `T²` / `p-value`, the **top-3 PC z-scores** (`analytics.risk`), a **dynamic PCA plot
  cycling PC1…PC6** with per-feature loading bars and the highest-loading feature per PC
  (`analytics.pca`), drift indicators, and lookalikes. Rows highlight/filter by risk label.
  ML service details shown live: **per-window compute time (ms)**, **temperature** (Pi temp
  source), and the ML process CPU / memory.
- **Connections.** Metadata-rich cards for gateway, analytics, redis, **sql** (sqlite), and
  **pipelines**: endpoint details, health, mini metrics (events/sec, bytes, last seen),
  add/edit connection metadata, and the test/sync controls.
- **Pipelines.** Training, webhook (ingest + score push), and **live WebSocket clients**
  rendered as pipelines with usable endpoints, events/sec, bytes, last-seen, and status;
  the UI can **register new pipelines** (consumer/webhook endpoints), persisted in the
  warehouse config.
- **Warehouse.** SQL view (db file, size, tables, columns, schema, row counts, raw
  columns) + Redis view (keys, types, TTL, memory, persistence) via the warehouse proxies.
- **Logs.** The existing log window, now including incoming **webhook** entries
  (`analytics.webhook`: batch size, record count, latency, auth result) plus the
  `training.*` / `pipeline.*` / `store.*` events.
- **Documents.** Renders the repo's docs in-app (PRD, `docs/analytics-layer.md`,
  README/quickstart).
- **How-to-use.** A guided page covering: pointing OpenCode at the gateway, running
  analytics, starting a training job, testing connections, and querying lookalikes.

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

### 10.7 Step-by-step: swap the default model to a 4-bit quant (Q8_0 → Q4_K_M)

The official `Qwen/Qwen3-1.7B-GGUF` repo ships only the `Q8_0` file; the 4-bit
**Q4_K_M** (imatrix) quant of the same model is published in a community mirror:

- **Repo:** `bartowski/Qwen_Qwen3-1.7B-GGUF` (Apache-2.0, imatrix)
- **File:** `Qwen_Qwen3-1.7B-Q4_K_M.gguf`
- **URL:** `https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf`
- **Size:** 1,282,439,584 bytes (~1.28 GB, vs ~1.83 GB for Q8_0)
- **SHA-256:** `72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb`

The swap is configuration-only — the model is data, not code, so nothing in the
image or `/opt/llama` changes. It reuses the standard atomic update mechanism
(§10.4): replacement only happens after a verified download, and a failed swap
leaves `current.gguf` untouched.

1. **Back up the current model values.** Save the running `MODEL_URL`,
   `MODEL_SHA256`, and `MODEL_QUANT` from `.env` for rollback (the old
   `current.gguf` is replaced, not kept).

2. **Point the config at the 4-bit file.** In `.env`, set:

   ```
   MODEL_URL=https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf
   MODEL_SHA256=72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb
   MODEL_QUANT=Q4_K_M
   ```

   `MODEL_NAME=Qwen3-1.7B`, `MODEL_FILE=current.gguf`, and `MODEL_DIR=/opt/qwen-model`
   stay as they are — the alias, filename, and mount are stable across quants.

3. **Reload the gateway config.** The gateway reads env at startup, so recreate the
   container: `docker compose up -d` (Compose recreates the service because the env
   file changed). A plain `docker compose restart` would keep the old env.

4. **Trigger the atomic swap.** The new URL/checksum come from config — the request
   needs no body:

   ```bash
   curl -s -X POST http://127.0.0.1:8080/api/model/update -H "x-api-key: <ADMIN_API_KEY>"
   ```

   Or use the Control Center: **Model → Update → Download & Update**. Progress
   (`downloading % → verified → swapping → done`) streams over `/ws`
   (`model.update` events). The GGUF is downloaded to `.download/`, SHA-256-verified,
   then atomically renamed to `current.gguf`; `llama-server` restarts and readiness
   is gated.

5. **Verify the swap.**
   - `GET /api/status` → `"llama":"ready"`, `"modelLoaded":true`.
   - `GET /api/model` → `"quantization":"Q4_K_M"`, `sizeBytes` ≈ 1,282,439,584,
     `sha256` = the 4-bit hash above, `downloadUrl` = the bartowski URL.
   - `GET /v1/models` → id still `Qwen3-1.7B` (the alias is unchanged).
   - A streaming completion still works and tok/s is reported in `/api/system`.

6. **Measure and re-tune.** CPU decoding is memory-bandwidth-bound, so the ~1.28 GB
   file (vs ~1.83 GB) should yield roughly 1.3–1.6× throughput over the ~8.7 tok/s
   baseline at `LLAMA_THREADS=4`. Re-measure with a live completion and adjust
   `LLAMA_THREADS` if needed. If output quality regresses for a real use case, the
   next step up is Q5_K_M (1.47 GB).

7. **Rollback.** Restore the saved `MODEL_URL`/`MODEL_SHA256`/`MODEL_QUANT` (Q8_0) in
   `.env`, run `docker compose up -d`, then trigger `POST /api/model/update` again —
   Q8_0 is re-downloaded, verified, and reinstalled the same way.

Notes:

- There is no public "Qwen3.5-1.7B" artifact; the intended target is the Qwen3-1.7B
  weights in 4-bit, served by the mirror above.
- No host script is involved: `scripts/update-model.sh` (referenced in §10.4) does
  not exist in the repo yet — the canonical path is the gateway API above, same as
  `scripts/ensure-model.sh` vs. the in-container `ensure-model.action`.

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
| `ANALYTICS_PORT`        | Analytics microservice port                   | `8081`                      |
| `ANALYTICS_URL`         | Base URL for gateway → analytics calls        | `http://analytics:8081`     |
| `INGEST_SECRET`         | Shared secret for the analytics webhook       | (required)                  |
| `REDIS_URL`             | Redis connection string                       | `redis://redis:6379`        |
| `ANALYTICS_FEATURE_WINDOW_SEC` | Feature aggregation window            | `60`                        |
| `ANALYTICS_CONTEXT_WINDOWS`    | Context windows fed to the model       | `12`                        |
| `ANALYTICS_EWMA_DECAY`  | EWMA reference decay per window               | `0.005`                     |
| `ANALYTICS_ML_DIR`      | Host ML artifacts dir (TFLite, checkpoints)   | `/opt/qwen-ml`              |
| `ANALYTICS_DB_FILE`     | SQLite store file (external mount)            | `/var/lib/analytics/analytics.db` |
| `ANALYTICS_PCA_COMPONENTS` | Max PCA components retained                | `6`                         |
| `ANALYTICS_PCA_WATCH_Z` | Watch-band σ threshold on top-3 PC z-scores   | `1.0`                       |
| `ANALYTICS_PCA_HIGH_Z`  | High-risk σ threshold (`≤ −h or ≥ +h` trips)  | `1.5`                       |
| `ANALYTICS_EMBED_ENABLED` | Enable lookalike embedding stores            | `true`                      |
| `ANALYTICS_EMBED_MODEL` | Transformer embedder model id (semantic store)| (unset)                     |
| `ANALYTICS_TRAIN_URL`   | Analytics → training service base URL         | `http://analytics-train:8082` |
| `REDIS_PERSISTENT`      | Persist Redis to disk (volume + appendonly)   | `true`                      |

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
├── gateway
│     ├── Express            (REST control + OpenAI proxy + WS + SSE proxy + static UI)
│     ├── node http-proxy    (lightweight reverse proxy / ingress)
│     └── llama-server       (127.0.0.1:8000, localhost-only)
│
├── analytics                (Python FastAPI + TFLite + scipy, :8081, internal only)
│     │                        ML serving layer · EWMA/PCA · drift · lookalikes · SSE stream
│     └── analytics-train    (Python, no exposed port, UI-startable TFLite training)
│
└── redis                    (internal; key cache, rate-limit counters, ingest escrow,
                             live-score cache; warehoused volume + appendonly)

ports:
  - "8080:8080"               # only exposed port

volumes:
  - /opt/qwen-model:/models            # model data (gateway only)
  - /opt/llama:/opt/llama:ro            # host-provisioned llama runtime (read-only)
  - /opt/qwen-ml:/opt/qwen-ml           # ML artifacts (analytics + analytics-train)
  - /opt/qwen-ml/state:/var/lib/analytics  # SQLite store file (external, survives recreation)
  - redis-data:/data                    # warehoused Redis (appendonly)

networks:
  internal stack only; analytics/redis/analytics-train unreachable from the LAN
  (only 8080:8080 is published)

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

- The streams table shows bounded inference-request rows (time, id, status, token counts, tok/s, duration) fed by `GET /api/requests` and live `request.*` WebSocket events; error rows drill down into the reason on click.
- The Playground streams a multi-turn conversation through `/v1/chat/completions` and renders the reply incrementally.
- The Viridis theme toggle switches and persists; JetBrains Mono Nerd Font is used when the client has it, with web fallback.
- The System card shows live CPU %, Memory %, temperature, disk, token rate, and API calls/min; the Host card shows the fastfetch-style instance details.
- The Realtime events card renders a tagged, auto-scrolling log with a Clear button.
- The sidebar scrollspy highlights the active section; the bottom status bar updates live (chips, CPU % / memory % / tok/s / API per min) with a ticking clock.
- No UI text overlaps: labels and values stay on separate flex rows/wrapped lines, and no raw JSON blobs render in status rows.
- Request records never contain prompt or response content.

### Analytics & risk layer

- The analytics microservice ingests gateway telemetry via the webhook and **re-scores
  every new window live** against the adaptive EWMA reference; no gateway request path
  blocks on analytics availability.
- Risk labels follow the top-3-PCA rule: any top-3 PC `z ≤ −1.5 or z ≥ +1.5` ⇒ **high**
  (direction-aware), `|z| ∈ [1.0, 1.5)` ⇒ **watch**, otherwise **normal**; the supporting
  Hotelling `T²` / `F-χ²` probability is also surfaced. Drift flags (PSI / KS / MMD,
  loading shift) are reported over historic windows and live.
- PCA retains up to `ANALYTICS_PCA_COMPONENTS` (6) components on the current rolling
  window; per-window components, eigenvalues, and per-feature loadings are stored and
  served (`/api/analytics/pca`), and the UI cycles PC1–PC6 with per-feature top-loading
  and label highlight/filter.
- SQLite stores request and window rows (features, `context`, PCs, a learned numeric
  embedding, and a separate semantic embedding) with `sqlite-vec` indexes for
  nearest-neighbor lookback; the db file is on an external mount. Redis backs the key
  cache, rate-limit counters, the ingest escrow, and the live-score cache, and is
  persisted (volume + appendonly) with its contents surfaced in the Warehouse view.
- Live `analytics.risk` / `analytics.drift` / `analytics.pca` / `training.*` /
  `pipeline.*` / `store.*` events reach the Control Center over the authenticated WebSocket
  via gateway fan-out AND over the SSE stream `GET /api/analytics/stream`; the UI holds a
  live connection on both.
- The Control Center exposes the orchestrator UI: dashboard test/sync buttons, the
  Analytics card (ML results + compute time, temperature, ML CPU/mem), Connections,
  Pipelines (usable endpoints + UI-registered pipelines), Warehouse (SQL + Redis),
  Logs (incl. `analytics.webhook` entries), Documents, and How-to-use.
- Analytics data is reachable only through admin-proxied `/api/analytics/*` on `:8080`;
  `:8081` is never published. The external Qwen project reads historic + live analytics
  through the same gateway proxy/SSE.
- Training data exports as labeled JSONL/CSV (`/v1/analytics/training/export` and the
  `/api/analytics/training/export` admin proxy); raw windows are available via
  `/v1/analytics/historic/windows`; in-app training (`POST /api/analytics/training/start`)
  produces artifacts under `/opt/qwen-ml` and `analytics` hot-reloads them.
- Transmitted metrics remain numeric-only — never prompt, response, or reasoning content.

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
- **Swap target (4-bit, optional, planned):** Qwen3-1.7B `Q4_K_M` via the
  `bartowski/Qwen_Qwen3-1.7B-GGUF` imatrix mirror (~1.28 GB — URL, SHA-256, and the
  step-by-step in §10.7). Default remains Q8_0 until the swap is executed. There is no
  public "Qwen3.5-1.7B" artifact; "3.5-1.7b in 4 bit" resolved as Qwen3-1.7B in Q4_K_M.
- **Expected context length:** `8192` (default).
- **Target tokens/sec:** ~8–10 on Pi 5 (measured ~8.7 at 4 threads on Cortex-A76-class); `LLAMA_THREADS=4`.
- **Pi 5 RAM:** 16 GB.
- **LAN key policy:** keys required by default; inference `/v1/*` + admin `/api/*` + `/ws`. No no-key mode.
- **Automatic updates:** opt-in, default `false`.
- Where additional runtime artifacts live on the host (e.g. `/opt/llama` assumed).
- Real-time metric sampling interval (proposal: 2–5 s for `system.metrics`).