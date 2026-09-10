# Mandatory Agent Rules 
These rules apply to every agent working in this repository. They are mandatory unless the user explicitly overrides them for a specific task.

## Highest Priority

Plan first. No quick fix. Work as a single agent — do not use workers or sub-agents.

- Treat this as the most important repository instruction for every run.
- If any task request feels urgent, small, or obvious, still plan first before changing code.
- Do not bypass this workflow unless the user explicitly says to ignore these repo rules for that specific task.

## Read Memory First

Every session starts by reading repo memory before any planning or code work:

1. Read `.ai/decisions/` — browse topic folders relevant to the task and read the decision files inside. This is where the "why" behind the codebase lives.
2. Read `.ai/sessions/` — find recent session files in topic folders relevant to the task. This is the AI work history: what was done before, what's unfinished, what was tried and rejected.
3. Only read what is relevant to the task. Do not load everything.

The full workflow for reading and writing these folders is in the `repo-memory` skill (`.claude/skills/repo-memory/SKILL.md`). Follow it in every session.

## No Workers or Sub-Agents

- Do not spin up worker agents, sub-agents, or parallel agent tasks for exploration, implementation, or review.
- All work — codebase exploration, planning, implementation, verification — is done directly by the single agent in the main session.
- This keeps the full context of the task in one place and every change reviewable in one thread.

## Agent Role

- The agent plans, brainstorms, coordinates with the user, implements, and reviews its own work.
- The agent must ask clarifying questions as needed. It should not rush from an unclear request into implementation.

## Planning and Approval Workflow

- Before implementation, the agent must discuss the approach with the user and produce a concrete plan.
- Implementation must not begin until the user approves the plan and explicitly asks the agent to proceed.
- After approval, the agent must break the plan into ordered subtasks before any code changes start.
- The agent must work through subtasks sequentially, completing and reviewing the current subtask before starting the next.

## Code Quality Rules

- Do not overcomplicate the codebase.
- Do not use quick fixes, hacks, or brittle patches.
- Do not optimize only for getting the latest bug fix or feature shipped.
- Every change must align with the existing architecture, style, naming, and patterns of the repository.
- Keep solutions clean, minimal, and maintainable.
- Avoid unnecessary abstractions, high-level design patterns, framework churn, or broad refactors.
- Prefer small, direct changes that reduce or preserve technical debt.
- Be careful about side effects and regression risk. Consider how a change interacts with nearby code and existing behavior.
- If the clean path is unclear, stop and ask questions during planning instead of guessing.

## Verification

- The agent must run the relevant checks (tests, type checks, lint, build) for each subtask when practical, and review the results before moving on.
- If checks cannot be run, the agent must report that clearly and explain the remaining risk.

## Memory Discipline

- `.ai/sessions/` — AI work history. One new file per local session, always. Never append to a previous session's file.
- `.ai/decisions/` — organizational decision history. High-level decisions and project logic only; the "why", never code detail.
- Both folders are organized as one level of topic folders with one file per session inside. Reuse an existing topic folder if one matches; only create a new one if nothing fits.
- Write the session file as you work and finalize it before the session ends. Record decisions the moment the user confirms them.
- Never hallucinate. If a fact is not in memory, in a plan, or in code, ask the user.

## Multi-Repo Projects

This repo may be one of several repos in a project (e.g. frontend, backend, super-admin frontend), checked out side by side under a root project directory. When the agent runs from that root:

- Each repo keeps its own `AGENTS.md`, `CLAUDE.md`, and `.ai/` memory.
- Session and decision files are written into the repo the work belongs to. Work spanning repos gets a session file in each affected repo.
- Never write memory files at the root level.

---

# Engineering Standards

Organization-wide standards: TypeScript everywhere, Node backend, React + Vite frontend, MongoDB, zod for validation.

## API Contract Is the Single Source of Truth

Applies to every project with a frontend/backend split.

- The canonical contract lives in the frontend repo under `contract/`. The frontend side owns it and edits it first.
- The backend repo keeps a local mirror at `contract/`. It is byte-identical at each cutover, updated by hand-copying changed files from the frontend repo when implementing a contract change. The backend's own `CHANGELOG.md` is frozen as a historical record — do not append to it.
- Backend imports the contract via relative paths from its local mirror (e.g. `import { exchange } from "../../../contract/endpoints/auth.contract"`). No npm linking, no shared contract package wrapper. The contract folder has no `package.json`.
- Frontend reads the canonical folder via a Vite path alias `@contract` → `./contract` (local to the frontend repo). Neither deploy needs the other repo at build time, and the repos do not need to be cloned side-by-side.
- Every API change starts by editing files under the frontend's `contract/` and appending an entry to the frontend's `contract/CHANGELOG.md` with status `needs-implementation`, the file changed, a summary, and the requesting side. That changelog is the live ledger for both sides.
- The backend agent landing the implementation hand-copies the changed contract files into the backend's `contract/`, implements the change, and flips the entry in the frontend's `CHANGELOG.md` to `done`.
- Backend zod validation imports schemas exclusively from its local `contract/` mirror — never re-defines request/response schemas in route files.

## Code Organization

- No JSON-driven workflow engines or config-defined business flows. Ever.
- Business logic lives in plain TypeScript orchestrator files. Each action gets its own file under `modules/<feature>/actions/<actionName>.action.ts`. Reading the file top-to-bottom describes the workflow in English.
- Helpers live as named exports on a static-style namespace object (e.g. `InvitationHelper.x()`), not class methods bound to `this`.
- Duplication > premature reuse in the first iteration. Refactor only when ≥3 call sites genuinely share behavior.
- No DI framework, no service container, no event bus. Plain imports.
- Files stay small. If an action file passes ~250 lines, split it.

## Persistence and Ops

- **Soft delete only.** Every collection has a `deletedAt: Date | null`. Hard deletes require explicit user approval.
- **Multi-tenant projects:** every collection carries the tenant key (e.g. `organizationId`) and indexes lead with `(organizationId, deletedAt, …)`.
- **Structured logging** with separate datasets/streams per environment (`<project>-dev`, `<project>-prod`). Default level: `info` in prod, `debug` in dev. Every action runs inside a logging context carrying `{ requestId, userId, action }` (plus tenant id where applicable). The logging vendor is set per project in the project-specific rules.
- **Encryption at rest:** all third-party credentials and API keys stored in the database are AES-256-GCM encrypted using a master key from env (`APP_ENCRYPTION_KEY`). Never store secrets in plaintext.
- **Auth:** Firebase Auth on the client → custom JWT exchange on the backend. Token sent via `Authorization: Bearer …` header. Multi-tenant projects pass the active tenant per request via an `x-org-id` header.

---

# Project-Specific Rules

## UI (React + Vite + Tailwind, `ui/` — serves via `gateway/public/`)

- The control-center UI lives in `ui/` and is served by the gateway from
  `gateway/public/`. The built SPA is copied there: `cp ui/dist/index.html
  gateway/public/` + `cp ui/dist/assets/* gateway/public/assets/` (one-shot swap;
  the dev compose service and the production Dockerfile `ui` stage alias the same
  dist). Zero gateway runtime changes for the UI.
- The built bundle is authoritative: after ANY UI source change, rebuild in a
  node:22 container (`npm ci && npx tsc --noEmit && npx vite build && npx vitest
  run`), re-copy `dist` into `gateway/public/`, and re-run the Playwright SPA sweep
  at the gateway origin. The Vite dev server (HMR) does NOT validate the shipped
  bundle.
- Regression bar (Playwright, `pi-sweep`): all 9 views render, zero console/page
  errors, WS + wire connected, zero page-level horizontal overflow (cards own inner
  `overflow-x:auto`; fixed 220px rail = parity with legacy).
- Detail records: `.ai/decisions/ui-refactor/` and `.ai/sessions/ui-refactor/`.
