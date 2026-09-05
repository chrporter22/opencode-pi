# JSON body parsing scoped to /api, never global

- **Date:** 2026-09-05
- **Developer:** opencode
- **Topic:** model-runtime

## Context / why

`app.use(express.json())` was registered globally in `gateway/src/index.ts` before the
`/v1` inference proxy router. Express is ordered-declarative, so the body parser consumed
the request stream before `http-proxy` could pipe it. Result: `POST /v1/chat/completions`
hung forever (the proxied body was empty), while `GET /v1/models` worked (no body). It only
surfaced once a live llama-server sat behind the proxy.

## Decision

Register `express.json()` **inside the `/api` admin router chain only** (after
`requireAuth`), never globally. `/v1/*` stays a raw pass-through to llama-server with the
body untouched; admin JSON endpoints keep their `1mb` limit.

## Rationale

The `/v1` proxy must forward the raw request stream (including streaming bodies) to
llama-server. Any global body-parsing middleware would break it. Keeping JSON parsing
scoped to the control plane (where the gateway actually reads JSON bodies) preserves both
behaviors.

## Impact

- `gateway/src/index.ts` — moved `express.json({ limit: "1mb" })` into the `/api` chain.
- Verified: streaming + non-stream inference work end to end; 42/42 tests pass.