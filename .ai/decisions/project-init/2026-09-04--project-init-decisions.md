# Project init decisions (naming, docs-first, UI, proxy)

- **Date:** 2026-09-04
- **Decided by:** user
- **Topic:** project-init

## Decision

1. The project is named **opencode-pi** everywhere (repo name and product name). The qwen-pi label from earlier discussion is superseded.
2. First milestone is **docs-only**: a full `PRD.md` and a project `README.md`. Code scaffolding (gateway, ui, scripts, Dockerfile, docker-compose) follows in later sessions.
3. The control center UI is a **single-file `index.html`** (vanilla HTML/CSS/JS, no build step) in `gateway/public/`, following the design pattern of the existing `rules-site/index.html`. Next.js/React/Tailwind/shadcn are explicitly dropped.
4. **Supabase is out of the project entirely** — not in the UI stack, not in the backend, and not in the docs (not even as future scope). Future-scope language is vendor-neutral.
5. The gateway is a **single :8080 LAN entry point** using `node http-proxy` as a lightweight reverse proxy (a lite nginx role) so OpenCode and other computers on the network reach the UI and the Qwen model through one port. `llama-server` stays bound to `127.0.0.1:8000` and is never exposed to the LAN.

## Why

- Keeps the Pi footprint minimal and the deployment to one container / one exposed port.
- A single-file UI mirrors an in-house pattern we already use and trust (`rules-site`), and avoids framework maintenance on a low-power device.
- A reverse proxy at the gateway gives LAN access to multiple surfaces (UI, control API, inference) without exposing the model server directly, and leaves room to add later services behind the same ingress.
- Avoiding external SaaS means nothing on the Pi depends on internet availability or third-party services for core operation.

## Supersedes / relates to

- Supersedes the earlier draft naming/structure discussions captured in session `2026-09-04-2306--prd-and-readme-docs.md`.