# Mandatory Agent Rules 
Copy this file into a Flutter repo as `AGENTS.md`. These rules apply to every agent working in this repository. They are mandatory unless the user explicitly overrides them for a specific task.

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

- The agent must run the relevant checks (`dart format`, `flutter analyze`, `flutter test`, and a build when practical) for each subtask, and review the results before moving on.
- If checks cannot be run, the agent must report that clearly and explain the remaining risk.

## Memory Discipline

- `.ai/sessions/` — AI work history. One new file per local session, always. Never append to a previous session's file.
- `.ai/decisions/` — organizational decision history. High-level decisions and project logic only; the "why", never code detail.
- Both folders are organized as one level of topic folders with one file per session inside. Reuse an existing topic folder if one matches; only create a new one if nothing fits.
- Write the session file as you work and finalize it before the session ends. Record decisions the moment the user confirms them.
- Never hallucinate. If a fact is not in memory, in a plan, or in code, ask the user.

## Multi-Repo Projects

This repo may be one of several repos in a project (e.g. mobile app, backend, admin frontend), checked out side by side under a root project directory. When the agent runs from that root:

- Each repo keeps its own `AGENTS.md`, `CLAUDE.md`, and `.ai/` memory.
- Session and decision files are written into the repo the work belongs to. Work spanning repos gets a session file in each affected repo.
- Never write memory files at the root level.

---

# Engineering Standards — Flutter

Organization-wide standards for Flutter apps: Flutter + Dart with null safety, Riverpod for state, go_router for navigation, Node backend, Firebase Auth. The backend keeps its own standards; these govern the app.

## Code Organization

- No JSON-driven workflow engines or config-defined business flows. Ever.
- Feature-first layout: `lib/features/<feature>/` with `screens/`, `widgets/`, and `actions/` inside. Shared code lives in `lib/common/` (widgets, theme, utils) and `lib/core/` (API client, auth, logging, routing). No `lib/src/` nesting on top of this.
- Business logic lives in plain Dart action files, one action per file under `lib/features/<feature>/actions/<action_name>_action.dart`. Reading the file top-to-bottom describes the workflow in English. Widgets and providers call actions; they do not contain business logic themselves.
- Helpers live as static methods on a namespace class (e.g. `InvitationHelper.x()`), not instance methods bound to objects passed around.
- Duplication > premature reuse in the first iteration. Refactor only when ≥3 call sites genuinely share behavior.
- No DI container, no service locator (`get_it`), no event bus. Riverpod providers are the only wiring; everything else is plain imports and static helpers.
- Files stay small. If a widget or action file passes ~250 lines, split it.

## State Management and Widgets

- Riverpod is the single state-management solution. Do not mix in Bloc, Provider, GetX, or hand-rolled `InheritedWidget` state.
- Local, ephemeral UI state (text controllers, animation state, toggles) stays in `StatefulWidget`s — do not lift it into providers.
- Widgets are dumb: they read providers, render, and dispatch to actions. No network calls, parsing, or branching business logic inside `build`.
- Split large `build` methods into private widget classes (not helper methods returning widgets) so `const` and rebuild boundaries work.
- Use `const` constructors wherever possible; the analyzer enforces this.
- All user-visible strings, colors, text styles, and spacing come from the central theme/constants (`lib/common/theme/`). No hardcoded `Color(0xFF...)` or inline `TextStyle` in feature code.

## Navigation

- go_router only. Routes are declared in one place (`lib/core/router.dart`) with typed path parameters.
- No `Navigator.push` with inline `MaterialPageRoute` in feature code; navigation goes through named routes.

## Data, Models, and Async

- Models are plain Dart classes with hand-written `fromJson`/`toJson` (or `json_serializable` if the project already uses it). No `freezed` or new code-gen dependencies without a decision recorded in `.ai/decisions/`.
- No `dynamic` in signatures, no `as` casts on JSON — parse at the edge (in the model layer, right where API responses enter), typed everywhere after. Never inline `Map<String, dynamic>` field access in feature code.
- Every `Future` is awaited or explicitly marked `unawaited(...)` with a reason. Every awaited call that can fail is handled — errors surface to the user via the shared error presentation, never swallowed in an empty `catch`.
- Check `mounted` (or use the Riverpod equivalent) before touching context/state after an `await` in widget code.

## Persistence, Security, and Ops

- **Tokens and secrets** live in `flutter_secure_storage` only. `shared_preferences` is for non-sensitive UI preferences. Never store credentials, JWTs, or API keys in plaintext prefs or in code.
- **Auth:** Firebase Auth on the client → custom JWT exchange with the backend. Token sent via `Authorization: Bearer …` header. Multi-tenant projects pass the active tenant per request via an `x-org-id` header. All of this lives in one place: the shared API client in `lib/core/`.
- **Deletes are backend soft-deletes.** The app never assumes hard deletion; deleted entities disappear from lists via the API, and destructive UI actions require an explicit confirmation dialog.
- **Structured logging** through one logging facade in `lib/core/logging/`, with dev/prod separation. Log `{ requestId, userId, action }` context around API calls (plus tenant id where applicable). No `print()` in committed code. The logging/crash-reporting vendor is set per project in the project-specific rules.
- **Environments:** dev/prod config via `--dart-define` (or `--dart-define-from-file`), read in one config file in `lib/core/`. No secrets committed; no environment branching scattered through feature code.

## Lints and Formatting

- `flutter_lints` as the base, with `analysis_options.yaml` committed. Warnings are errors in CI: `flutter analyze` must pass clean.
- `dart format` is the only formatting authority. No manual style debates, no format-diverging commits.

---

# Project-Specific Rules

<!--
Add rules specific to this project below: architecture decisions, logging/crash
vendor, tenant model, UI direction, deviations from the engineering standards, etc.
These sit on top of the mandatory rules and engineering standards above.
-->

(None yet.)
