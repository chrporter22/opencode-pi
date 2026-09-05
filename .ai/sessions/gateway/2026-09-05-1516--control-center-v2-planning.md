# Control Center v2 planning (UI overhaul + request telemetry)

- **Date:** 2026-09-05 15:16
- **Developer:** opencode
- **Topic:** gateway
- **Preceding:** model-runtime 1430 (trixie pivot + live inference). This session is
  planning only — no code changed.

## Request

"ok; plan out next steps; ui clean up text overlap issues; tabulate sse metrics and
streams show convo windows incorperate viridas color scheme enhancement theme subtle nerd
font mono jet brains as text." Then: "write ui plan to readme and prd and update .ai
folders."

## What was done

- Re-read the control center frontend and backend: `gateway/public/index.html`,
  `src/index.ts`, `src/routes/v1.ts`, `src/routes/control.ts`, `src/routes/ops.ts`,
  `src/state.ts`, `src/metrics.ts`, `src/ws.ts`, `src/logger.ts`,
  `src/modules/llama/supervisor.ts`, `PRD.md`, and `test/v1-proxy.test.ts`.
- Gap analysis: PRD §6.8 #37 / §6.11 `request.*` events and §9.4 Playground are spec'd but
  not implemented. `ws.ts` broadcasts only state / log / metrics; `v1.ts` is a single
  catch-all proxy with no instrumentation point; the UI status row dumps a raw
  `JSON.stringify(...)` blob into a `space-between` flex row (the overlap source); there is
  no theme or custom typography.
- Asked the user to pin down three ambiguous points; the confirmed choices are recorded in
  the decision file (playground = convo windows, system-first Nerd Font, theme toggle).
- Wrote the plan into `PRD.md` (§6.12 reqs 43–50, §7.1 `GET /api/requests`, §8 `request.*`
  payloads, §9.4–9.7, §20 Control Center acceptance) and `README.md` (Control center
  section + "Control Center v2 (planned)" + a status bullet).
- Recorded this session and the confirmed decisions in `.ai/`.

## Notable findings

- **PRD already owns most of this.** Request lifecycle observability (§6.8 #37, §6.11,
  §8) and a test chat interface (§9.4) were in the original spec — v2 implements them
  rather than inventing new product.
- **No body parse on `/v1` (deliberate).** After the json-parser decision, `/v1` is a raw
  passthrough. Token accounting therefore must sniff the *response* stream (`res.write`)
  for numeric `usage` fields (JSON `usage` or the final SSE chunk before `[DONE]`), not the
  request. Model per record comes from `config.model.name` (single-GGUF serve), so no
  request-body inspection is needed.
- **Instrumentation points.** `routes/v1.ts` middleware → request id + tracker.start;
  `proxy.on("error")` and `res.on("close")` without finish → error; `res.on("finish")` →
  complete. The not-ready 503 path also records an error.
- **Ring pattern to mirror:** `logger.ts` (bounded ring + subscribe + snapshot); wire a
  tracker into `v1Router`, `controlRouter`, and `startWsServer` from `index.ts`.
- **Font reality:** JetBrains Mono Nerd Font is a *patched* font and is not on Google
  Fonts. That drove the confirmed system-first + web-fallback decision (no CDN Nerd Font,
  no new files self-hosted).
- **Viridis ramp:** `#440154 → #3b528b → #21918c → #5ec962 → #fde725`; used as an accent
  palette and a tok/s ramp, kept subtle per the user's phrasing.
- **Concurrency ceiling:** `LLAMA_PARALLEL=1` (default) ⇒ one in-flight inference; the
  plan keeps one conversation window this iteration and surfaces llama's busy/503 behavior.
- Test infra: vitest in `gateway/test/` (`makeConfig` helper, real upstream on an
  ephemeral port in `v1-proxy.test.ts`); 42 tests green; `tsc --noEmit` clean.

## Open threads

- **Implementation not started.** Plan is now in PRD/README; awaiting user go-ahead, then
  ordered subtasks: request tracker → v1 instrumentation → ws/control/index wiring →
  tests → UI.
- Single conversation window this iteration; multi-window is a later frontend-only step.
- Playground needs the **Inference API key** in the browser (new Connection-card input,
  `localStorage`) — the admin key alone cannot call `/v1/*`.
- Git still not a repo; user initializes/commits/pushes themselves.
- Leftover user-side cleanup: `sudo rm -rf /tmp/opencode/llama-test`.