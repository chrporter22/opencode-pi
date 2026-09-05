# PRD and README docs

- **Date:** 2026-09-04 23:06
- **Developer:** opencode
- **Topic:** project-init

## Request

Plan the opencode-pi project (a LAN-only local AI control center for a Raspberry Pi: llama-server + Express gateway + browser control center) and write two docs first: `PRD.md` and a project `README.md`.

## What was done

- Wrote `PRD.md` at the repo root: overview, goals/non-goals, architecture, repo layout, numbered requirements 1–42 (items 41 Web Control Center and 42 WebSocket API per user spec), control/inference/WebSocket API references, control-center UI spec, security, deployment, vendor-neutral future scope, open questions.
- Replaced the repo-template `README.md` with an opencode-pi project explainer (what it is, architecture, layout, quickstart, API summary, status checklist).
- Created session + decision files under `.ai/` (`project-init/` topic).

## Notable findings

- The repo (named `opencode-pi`) started as a copy of the agent-rules template; not a git repo yet and no project code. This session is docs-only.
- The UI is a single-file `index.html` in `gateway/public/` following the `rules-site/index.html` pattern (vanilla HTML/CSS/JS, no build step); Next.js/shadcn dropped per user direction.
- Supabase is excluded entirely — no mention in the docs, not even as future scope; future-scope language is vendor-neutral.
- The gateway uses `node http-proxy` as a lightweight reverse proxy: one LAN port `:8080` routes `GET /` (static UI), `/api/*` (control, admin key), `/v1/*` (proxied to llama-server, inference key), `/ws` (realtime, admin key). llama-server stays on `127.0.0.1:8000` inside the container, never on the LAN.
- Two-key auth (inference + admin); credentials stripped at the gateway and never forwarded to llama-server; prompts/responses never logged by default — all captured in the PRD.

## Open threads

- No code exists. Next sessions: scaffold `gateway/` (Express + http-proxy + auth + model management), `gateway/public/index.html` control center, `scripts/`, `Dockerfile`, `docker-compose.yml`.
- PRD paths/naming (e.g. model volume `/opt/qwen-model`) are targets, not yet verified against an implementation.
- Open questions in PRD §12 (model volume location, key rotation, metrics interval) still need owners.