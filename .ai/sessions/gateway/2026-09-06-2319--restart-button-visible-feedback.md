# Restart button: visible feedback + status-bar llama chip fix

- **Date:** 2026-09-06 23:19
- **Developer:** opencode (big-pickle)
- **Topic:** gateway — Control Center UI
- **Preceding:** model-runtime 1900 (model-swap plan) + commit `cdf9044` (backend
  restart robustness + tests)

## Request

"read agents.md docs .ai files and plan to fix refresh button" → clarified by user: the
**Restart model** button on the Control Center UI "doesn't restart the model". Tracing
showed the backend `POST /api/model/restart` path is correct (single-flight, tested in
`gateway/test/llama-restart.test.ts`); the defect is that the UI gives no visible
in-flight feedback — the button only wrote a transient line to a hidden `pre#modelLog`,
and since it's the same model nothing on screen changes when llama comes back. User
confirmed the fix is "**make restart visible**" (button state + status line), and to
also fix the pre-existing status-bar llama chip mapping.

## What was done

All changes in `gateway/public/index.html` (frontend-only, no backend/contract changes):

1. **Replaced hidden `pre#modelLog` with visible `#modelAction` status line** — a styled
   `.action-line` div inside the Model card, with `.ok`, `.err`, `.warn` state classes
   and a CSS spinner animation for the in-flight state.

2. **New restart flow (`restartModel()`):**
   - On click: immediately disables `#btnRestart`, labels it "Restarting…", sets top
     status dot to `.dot.warn` (yellow, new CSS class), shows "Restarting model…"
     in the status line.
   - After HTTP 200 from `POST /api/model/restart`: starts polling `/api/status` every
     1s until `llama === "ready"` && `modelLoaded === true` (success) or
     `llama === "error"/"stopped"` (failure).
   - Also reacts to WS `llama.status` events immediately if a restart is in-flight.
   - On resolution: restores button, clears dot to green (or error), flashes a brief
     "Model ready" (or error detail), auto-clears the status line after 2.5s.

3. **`refresh()` no longer clobbers the restarting dot** — the health-check + dot
   assignment is skipped while `modelRestartState.inFlight` is true.

4. **Fixed `renderStatusbar()` llama chip** — now maps real backend statuses:
   - `ready`/`online` → ok chip showing "ready"
   - `starting`/`restarting` → warn chip showing the status
   - `error`/`stopped`/other → err chip showing the status
   - Previously compared against `"online"` (never emitted by backend) → always
     showed "offline".

5. **Fixed `system.metrics` WS handler** — passed the current llama status from the
   status bar chip instead of hardcoding `llama: "online"`, preventing metrics events
   from clobbering the correct llama state during restart.

## Notable findings

- Backend restart was already fixed/robust in commit `cdf9044`; no backend/contract
  change needed for this task.
- `renderStatusbar()` (index.html) compared `state.llama === "online"`, but the backend
  `LlamaStatus` union is `not_started | starting | ready | restarting | stopped |
  error` — the status-bar chip never matched and always showed "offline".
- The Model card llama chip already renders `restarting` correctly via
  `chip("mLl", s.llama)` (not in ok/err → warn).
- `llama-restart.test.ts` has 5 pre-existing timing failures in the container (stub-
  llama fixture timeout), unrelated to this HTML-only change. All 55 other tests pass.
- `npm run typecheck` clean; extracted `<script>` passes `node --check`.

## Verification

- `node --check` on extracted `<script>`: OK
- HTML tag balance check: OK
- `npm run typecheck` (container): clean
- Backend tests: 55/60 pass (5 pre-existing `llama-restart.test.ts` failures)
- Files touched: `gateway/public/index.html` only

## Decision

Recorded at `.ai/decisions/gateway/2026-09-06--restart-button-visible-feedback.md`
