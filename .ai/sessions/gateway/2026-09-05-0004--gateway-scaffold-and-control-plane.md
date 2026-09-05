# Gateway scaffold and M1 control-plane code

- **Date:** 2026-09-05 00:04
- **Developer:** opencode
- **Topic:** gateway

## STATUS: M0 + M1 VERIFIED (2026-09-05 00:30)

Lockfile, images, typecheck, tests, and the full live smoke passed. The only remaining M1
work is the deferred M2 milestone (see Open threads). The Docker-group blocker from below is
resolved: user ran `sudo usermod -aG docker pi5_nvme` and rebooted.

### Verification results
- `package-lock.json` generated in-container; `npm ci` builds in both Dockerfiles.
- `docker compose build` (gateway-dev, gateway-test) and `docker build -f Dockerfile` (prod) all succeed.
- `npm run typecheck` (tsc --noEmit): clean.
- `npm test` (vitest): 26/26 pass across config/auth/logger/routes.
- Live prod image (`node dist/index.js`) on host port 8081:
  - `/health` 200 open; `/` serves static UI 200 without key; unknown path 404.
  - `/api/*` 401 without/with-wrong key; 200 with `dev-admin-key`; scope separation holds
    (admin key cannot use `/v1`).
  - `/api/status`, `/api/model` (installed:false, correct llamaArgs), `/api/metrics`
    (cpu/ram/thermal read from /proc + /sys), `/api/logs` (ring), `/api/system` all 200.
  - `/v1/*` with inference key → 503 (`inference not ready`) as M1 contract; model ops → 501.
  - WS `/ws?key=dev-admin-key` receives `system.metrics` broadcasts every 5s; wrong key rejected.
  - `POST /api/server/restart` → 202, then graceful exit (logs "Shutting down" / "Gateway
    stopped"), container `Exited (0)`, and `docker start` restores a 200 gateway.
- stdout logging confirmed in `docker logs` (`[info] Gateway listening ...`, `Gateway ready`).

## Request

Build M0 (docker/container scaffold) and M1 (control plane) of the opencode-pi gateway per
PRD.md: latest code based on the approved docs; verification via Docker; then record a pickup
section so the user could grant Docker access and reboot.

## What was done

- **M0 root plumbing:** `.gitignore`, `.dockerignore`, `.env.example`, `.env` (dev keys
  `dev-inference-key` / `dev-admin-key`, gitignored), `model/README.md`.
- **M0 build plumbing:** `gateway/package.json` (express 5, http-proxy 1.x, ws, zod; dev: tsx,
  vitest, supertest), `gateway/tsconfig.json` (ESM, NodeNext, strict), `Dockerfile.dev`
  (node:22-alpine, `npm ci`), `Dockerfile` (multi-stage build → slim runtime, wget healthcheck
  on `/health`), `docker-compose.yml` (services `gateway-dev` :8080 and `gateway-test`).
- **M1 gateway source (`gateway/src/`):** `config.ts` (zod env schema + typed `Config`),
  `logger.ts` (ring buffer + subscribers + stdout), `auth.ts` (`x-api-key`/`Bearer`,
  admin/inference scopes, fixed-time compare), `state.ts` (RuntimeState emitter),
  `metrics.ts` (CPU/RAM/thermal/disk via /proc + /sys + statfs, all null-safe),
  `ws.ts` (noServer upgrade, admin key via `?key=`, broadcasts state/log/metrics events),
  `routes/health.ts` (open `/health`), `routes/control.ts` (subtree `/status`, `/model`,
  `/system`, `/metrics`, `/logs`), `routes/ops.ts` (`/model/update|restart` = 501,
  `/server/restart` = 202 + graceful exit), `index.ts` (boot order, `/api` admin chain,
  `/v1/*` → 503 until M2, SIGTERM/SIGINT graceful shutdown).
- **M1 UI placeholder:** `gateway/public/index.html` (vanilla, health/status + admin-key
  input + WS event feed).
- **M1 tests (`gateway/test/`):** `auth.test.ts`, `logger.test.ts`, `config.test.ts`,
  `routes.test.ts` — 26 tests, all green.

## Notable findings

- Host port **8080 is already taken** by another project's container (`pca_pipeline-frontend-1`,
  host 8080 → container 80). `docker compose up gateway-dev` will fail to bind there until that
  project is stopped or the gateway moves ports. Live smoke used a one-off `-p 8081:8080`.
- Found two bugs only the live container exposed (unit tests didn't reach `index.ts` wiring):
  1. Routers defining full `/api/*` paths were mounted under `/api`, yielding `/api/api/*`
     (404s). Fixed: routers now define subtree paths and are mounted once under `/api`.
  2. A bare root `app.use(requireAuth(admin), ...)` scoped admin auth to every path including
     `/v1` and static `/`. Fixed by mounting the chain under `/api` only.
- `createLogger` initially never wrote to stdout (ring only); `docker logs` was empty despite
  the app running. Added stdout output (PRD logging requirement), `stdout: false` in tests.
- **Self-restart nuance:** the graceful exit is `process.exit(0)`. Under `tsx watch` (dev) the
  supervisor also exits and the container stays stopped (docker start brings it back). Under
  prod `node dist/index.js` + a `restart` policy the container restarts as intended. Dev compose
  service has `restart: unless-stopped`, so dev self-restart recovers too.
- Metrics read host-wide values through `/proc`/`/sys` (same host as llama-server — acceptable),
  so CPU/memory are host-level, not per-container.
- `docker compose run --rm gateway-test npm test/typecheck` are the repeatable check commands.
- Local instructions: to run the dev stack yourself use `docker compose up gateway-dev` (8080 is
  free only if `pca_pipeline` is stopped; otherwise override the port).

## Open threads

- **M2 (next milestone, already user-scoped, NOT started):** llama-server supervision,
  `/v1/*` real proxy with SSE streaming, `scripts/install.sh`/`update.sh`/`cleanup.sh`,
  real `/api/model/update`, model readiness gating.
- Port conflict on 8080 with the `pca_pipeline` project on this Pi — decide ownership when M2
  deployment lands.
- PRD §23 build inputs (exact Qwen3.5 size/quant/URL, MODEL_SHA256, RAM/cooler/storage, target
  tok/s, LAN key policy) still undecided.
- Repo is still not a git repo (user deferred); `git init` + first commit proposed once M1 review
  signs off.
- Proxy currently forwards nothing upstream — `http-proxy` dependency is unused until M2; keep
  for the stated lite-nginx role.