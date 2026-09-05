# Integrate original PRD detail into docs

- **Date:** 2026-09-04 23:27
- **Developer:** opencode
- **Topic:** project-init

## Request

After the first PRD/README pass, the user supplied the original product spec (§1–40: hosting, goals, network/bind rules, model-as-data, startup/auto-download, update/failure semantics, disk management, env config, security, streaming, health checks, backup, recovery, acceptance criteria, design principles, future scope, open questions). Asked to review against `PRD.md`, confirm integration, and update the PRD + README (docs only, before the build).

## What was done

- Reworked `PRD.md` (v0.2) to fold in the original §1–40 while keeping requirements numbered 1–42 with items 41 (Web Control Center) and 42 (WebSocket API) verbatim as the user specified.
- New/expanded sections: Scope & hosting; explicit bind rules (`0.0.0.0:8080` vs `127.0.0.1:8000`, publish only 8080); Runtime provenance (model + llama binary both external to image); Model lifecycle & data management (startup sequence, ensure-model staging, update-model, failed-update/rollback, single-file disk rule); full environment table; process model/signals/restart policy; health/readiness; logging; security; backup; failure recovery; first deployment + OpenCode test; acceptance criteria; design principles; expanded future scope and open questions.
- Rewrote `README.md` with the integrated flows (first-run provisioning, script + control-center update paths, env summary, cleanup, status checklist).
- Added session + decision files.

## Notable findings

- Core requirement list was restructured into exactly 40 numbered core requirements plus 41/42, so the user's verbatim additions keep their numbers.
- Resolved conflicts: two-key auth supersedes the early single `GATEWAY_API_KEY` (now mapped to the inference key); the Docker image is Node-gateway-only (llama binary host-provisioned at `/opt/llama` and mounted `:ro`) — this supersedes the original single-image-with-llama idea; update paths coexist (`scripts/update-model.sh` + gateway `/api/model/update` sharing one atomic mechanism).
- Original §37 "future" items (web control center, dashboard, CPU/temp/tok-s, request metrics) are now in v1 scope via PRD §9 / §6.11 — noted in the future-scope section.

## Open threads

- Undecided build inputs still open (PRD §23): exact Qwen3.5 size/quant/URL, `MODEL_SHA256` availability, Pi 5 RAM/cooler/storage, target tok/s, LAN key policy, auto-update opt-in.
- Build itself not started — next session begins M0 (gateway scaffold) after the updated docs are approved.