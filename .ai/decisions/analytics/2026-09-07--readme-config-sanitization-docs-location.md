# README config sanitization + analytics docs location

- **Date:** 2026-09-07
- **Decided by:** user (in session 2026-09-07-2200)
- **Topic:** analytics

## Decision

1. The README opencode sample config carries **no real secrets and no machine-specific addresses** — the inference key and the Pi LAN IP are placeholders (`<INFERENCE_API_KEY>`, `<pi-ip>`). Users write their own `opencode.json`; the agent only shows a copy-paste block in chat when a user asks "what to paste".
2. Analytics documentation lives in the existing `docs/analytics-layer.md` (single source), and the Control Center UI gets its own **Analytics docs + visual pipeline flow chart** section that links back to it. No separate docs-only page was created.

## Why

- Publishing the working dev key or a hardcoded LAN address in the README is a security/staleness footgun: the key is a real credential and the IP is environment-specific (also this README lives in a git repo).
- Keeping one canonical doc file (already indexed and linked from the Docs view) avoids doc drift; the UI flow chart gives operators the mental model in-page, which is why a UI section (not just a doc) was requested.
- The model id in sample configs must stay `Qwen2.5-Coder-3B-Instruct` because the gateway aliases whatever GGUF is loaded to that id (`GET /v1/models`), so any other id silently breaks opencode.

## Relates to

- `2026-09-07--analytics-rename-persistence-writeback-scope.md` (doc ownership/scoping precedent for the analytics layer).