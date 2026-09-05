# Control Center v2 scope — streams table, playground, Viridis toggle, Nerd Font

- **Date:** 2026-09-05
- **Developer:** opencode
- **Topic:** gateway
- **Stakeholder:** user (confirmed the three choices in-session via clarifying questions)

## Decision

The control center ("next steps") work is scoped as **Control Center v2**, recorded in
PRD §6.12 / §9.4–9.7:

1. **"Convo windows" = a chat Playground** — one multi-turn conversation window streaming
   through the real `/v1/chat/completions` path (PRD §9.4), NOT llama-server
   slot/context-window occupancy tracking.
2. **Inference streams table** — fed by a bounded in-memory request ring (`started` /
   `completed` / `error`) exposed as `GET /api/requests` (admin key) and the existing
   `request.*` WebSocket events. Records are numeric telemetry only — they never contain
   prompt or response content (preserves the no-prompt/no-response-logging rule, PRD §6.7
   #33). Token counts are sniffed from the proxied response stream (JSON `usage` or the
   final SSE chunk), leaving streaming unbuffered.
3. **Font: JetBrains Mono Nerd Font, system-first** — CSS stack
   `"JetBrainsMono Nerd Font" → "JetBrains Mono"` (Google Fonts fallback) → system mono.
   No CDN Nerd Font, no self-hosting new files.
4. **Theme: dark default + subtle Viridis toggle** — a header toggle between the neutral
   dark theme (default) and a Viridis-tinted dark variant (`#440154→#3b528b→#21918c→
   #5ec962→#fde725` as accents/ramps), persisted in `localStorage`.

## Why

- PRD §6.8 #37 and §6.11 already mandated observable request lifecycle, and §9.4 a test
  chat interface — this plan implements them instead of adding new product scope.
- Playground chosen over context-window tracking because it tests the same production
  inference path OpenCode uses and is already in spec; context-window/slot occupancy adds
  `--parallel`/`/slots` machinery out of proportion to the ask.
- System-first font keeps the repo single-file and works offline on the laptop (where the
  Nerd Font is installed); the Google-Fonts fallback covers browsers that lack it.
- Viridis is applied as a *subtle* accent/ramp (not a full recoloring) per the user's
  "enhancement theme subtle" phrasing; it also gives a perceptually-uniform way to encode
  tok/s (fast = yellow end).
- "No-overlap layout" fixes (flex `gap`/`wrap`/`min-width:0` + `overflow-wrap`, chips
  instead of raw `JSON.stringify` blobs) are treated as mandatory hygiene, not optional.

## Notes

- Recorded at planning time; implementation + tests are tracked in the session file
  (`.ai/sessions/gateway/2026-09-05-1516--control-center-v2-planning.md`).
- At `LLAMA_PARALLEL=1` only one inference can be in flight; the Playground keeps a single
  conversation window this iteration and surfaces llama's busy/503 behavior otherwise.

## Relates to

- `2026-09-05--json-parser-scoped-to-api.md` — why `/v1` must not be body-parsed, hence
  response-stream sniffing for token accounting.
- `2026-09-05--build-phasing-and-framework-choices.md` — single-file vanilla UI pattern,
  plain-TS module organization.