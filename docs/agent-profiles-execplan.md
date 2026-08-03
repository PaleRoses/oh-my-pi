# Make agent profiles own constitution, memory, and execution policy

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` remain current as work proceeds.

## Purpose / Big Picture

An OMP operator can define any number of named agent profiles. A profile selects either one provider-facing constitution overlay or the maintained harness prompt alone, a Hindsight bank and tag scope, an allowed model set, and an optional exact tool capability set. Ordered routes choose an initial profile for a top-level or task agent, while `--agent-profile <id>` selects one explicitly. The selected profile is pinned to the session: retries and model fallbacks may change models only when the profile permits them, and they never silently replace the identity or memory bank.

The behavior is visible by configuring `driver` and `worker` profiles, starting a top-level Fable session, and spawning a task. Both prompts retain OMP's maintained operational scaffold. The root adds only the driver constitution and uses the driver bank; the child adds only the worker constitution and uses the worker bank. A disallowed fallback is rejected before the active model changes. A profile tool allowlist can only narrow the tools the session would otherwise receive.

The interactive `/agent-profile` command changes identity without restarting the OMP process. It closes the current session at an idle boundary, creates a fresh transcript under the selected profile, and reconstructs every profile-owned runtime surface before accepting another prompt. The previous session remains resumable and no transcript, prompt, memory backend, provider session, prompt-cache identity, tool set, or subagent registry crosses the boundary.

## Progress

- [x] (2026-08-02 08:10Z) Read the existing prompt router, model transition owner, Hindsight lifecycle, tool restriction path, CLI profile bootstrap, and session persistence owners.
- [x] (2026-08-02) Replaced the narrow system-prompt profile schema and resolver with the single agent-profile owner.
- [x] (2026-08-02) Selected and persisted one profile at session construction; existing session identity is authoritative and conflicting explicit selection fails closed.
- [x] (2026-08-02) Layered exactly one selected constitution over the maintained harness prompt without rendering unselected profiles.
- [x] (2026-08-02) Threaded profile Hindsight scope through memory startup and separated child state when its scope differs from the parent.
- [x] (2026-08-02) Pinned model policy through every model transition and intersected optional profile tools with caller capabilities before tool and MCP construction.
- [x] (2026-08-02) Covered top-level, child, explicit multi-profile, resume, prompt singularity, memory separation, fallback denial, capability narrowing, project-context filtering, and lazy header persistence.
- [x] (2026-08-02) Ran the focused tests, coding-agent type/style check, binary build, active-config route smoke, and SDK smoke scenario.
- [x] (2026-08-02 22:50Z) Added the interactive profile selector and `/agent-profile <id> [provider/model]` command with typed idle-boundary handoff and allowed-model selection.
- [x] (2026-08-02 22:50Z) Replaced the live AgentSession in-process with a fresh transcript, prompt, Hindsight backend, extensions, tools, MCP/LSP resources, provider state, and lifecycle generation.
- [x] (2026-08-02 22:50Z) Proved driver-to-worker-to-driver switching with distinct session IDs, profile headers, provider-facing prompts, model policies, tool sets, and fresh transcript roots; memory scope and resume remain covered by focused construction/persistence tests rather than the live smoke.

## Surprises & Discoveries

- Observation: OMP already has a bootstrap-global `--profile` that relocates all user-level paths. It cannot vary between concurrent in-process agents and is therefore not the owner for task-agent identity.
  Evidence: `docs/config-usage.md` states that profile selection relocates `~/.omp/agent` during bootstrap; `src/cli/profile-bootstrap.ts` runs before modules read `getAgentDir()`.

- Observation: Initial routes cannot safely run on later model transitions because doing so would change identity inside an existing transcript.
  Evidence: `AgentSession` stores one selected profile ID and all model transition owners call its immutable model-policy assertion instead of consulting routes.

- Observation: A task can alias its parent's Hindsight runtime only when both resolve to the same structural bank and tag scope.
  Evidence: `src/hindsight/backend.ts` compares `BankScope` values before aliasing and constructs an independent state when they differ.

- Observation: Tool filtering must precede every optional tool factory and MCP discovery, not filter only the final tool array.
  Evidence: `src/sdk.ts` uses the profile intersection to gate LSP, IRC, computer, inspect-image, memory startup, vibe tools, MCP discovery, and custom-tool loading.

- Observation: Fable-specific context can enter through user-global context files and MCP server instructions independently of the selected base prompt.
  Evidence: the worker profile uses `projectContextOnly: true` and an exact tool boundary with no MCP tool names; integration coverage proves project `AGENTS.md` remains while user-global `CLAUDE.md` is absent.

- Observation: Lazy sessions do not need eager empty-file materialization to persist identity.
  Evidence: the first assistant append crosses the existing lazy gate and cold-rewrites the full current header, including `agentProfile`; `session-manager-immediate-persist.test.ts` exercises that real path.

- Observation: The existing custom-system-prompt slot replaces OMP's maintained role, tool policy, execution workflow, and delivery contract; it is therefore not the profile-constitution owner.
  Evidence: `buildSystemPrompt` selects `custom-system-prompt.md` whenever `resolvedCustomPrompt` is present, and that template intentionally omits the stable operational scaffold. The profile composition regression asserts all four maintained sections remain alongside the selected constitution.

- Observation: `InteractiveMode` owns slash-command dispatch and terminal lifecycle, while `main.ts` owns AgentSession construction and therefore must own profile replacement.
  Evidence: builtin TUI commands receive only `InteractiveModeContext`; `runRootCommand` alone holds the model registry, auth storage, session factory, extension preload inputs, and `CreateAgentSessionOptions` required for a complete reconstruction.

- Observation: normal interactive shutdown terminates the process and leaves the process-global `AgentLifecycleManager` disposed.
  Evidence: `InteractiveMode.shutdown()` always calls `postmortem.quit(0)`, and `AgentLifecycleManager.dispose()` unsubscribes its registry listener without making a later `global()` call construct a live replacement.

- Observation: The generic startup session resolver intentionally returns no manager for a fresh session and may auto-resume an existing session.
  Evidence: interactive profile transitions construct `SessionManager.inMemory(cwd)` or `SessionManager.create(cwd, sessionDir)` directly, so every switch receives a fresh transcript regardless of startup resume policy.

## Decision Log

- Decision: Replace the prompt-only router outright with `agentProfiles` and `agentProfileRoutes`; do not retain aliases or a parallel router.
  Rationale: one owner avoids duplicate constitution and identity policy.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Keep native `omp --profile` unchanged and name explicit identity selection `--agent-profile`.
  Rationale: native profiles own process-global path discovery; agent profiles own one session and can differ between root and child sessions.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: A selected profile is sticky. Routes choose only the initial profile, and every later model transition is checked against that profile’s model globs.
  Rationale: model is execution substrate, while profile is identity. Re-routing on fallback would expose the existing transcript and memory to another identity.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Render the selected profile constitution as a distinct system block over the selected harness base.
  Rationale: agent profiles vary identity without silently deleting OMP's maintained operational contract. An explicit custom base remains composable and cannot erase the selected profile constitution.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Profile capability policy is an optional exact tool allowlist interpreted through the existing restricted-tool path.
  Rationale: this is a real fail-closed capability boundary and requires no second permission framework. Model globs supply the fallback policy: a fallback outside the set is denied before mutation.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Load every configured constitution source once when constructing the session resolver.
  Rationale: the existing resolver is session-scoped and already performs bounded startup I/O. Lazy per-selection loading would make the pure selection boundary asynchronous without reducing provider work or prompt bytes.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Permit `useDefaultPrompt: true` as the third, exclusive constitution source.
  Rationale: driver and neutral worker identities can select the maintained harness prompt without adding a profile-specific constitution block.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Add `projectContextOnly` as a profile-owned context boundary.
  Rationale: a neutral worker needs project rules but must not inherit user-global identity context; filtering the existing context-file input is smaller and more exact than a second context loader.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Route only Fable-backed main sessions to the active `driver`; route tasks and fresh non-Fable sessions to `worker`; allow no cross-model driver fallback.
  Rationale: another model wearing Fable's constitution or memory is the failure this feature exists to prevent. A driver provider failure therefore fails rather than substituting identity.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: An interactive profile change creates a new transcript and disposes the old AgentSession; it never mutates `SessionHeader.agentProfile` in place.
  Rationale: constitution, memory scope, model policy, capabilities, and provider cache identity are session invariants. A fresh session makes the boundary observable and keeps the previous identity resumable.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Reuse the OMP process and terminal, not the profile-owned runtime.
  Rationale: process restart is unnecessary latency, while reusing an AgentSession, Hindsight state, extension runtime, MCP manager, or subagent registry would violate the identity boundary.
  Date/Author: 2026-08-02 / Blue Rose

- Decision: Permit a transition only while the session is idle. An explicit command model selects the target substrate; otherwise preserve the current model when allowed and require an allowed-model selection when it is not.
  Rationale: quiescence avoids interrupting or transferring an in-flight turn. Model choice is resolved before teardown, so the target profile never starts on a forbidden substrate and no identity boundary depends on a later `/model` mutation.
  Date/Author: 2026-08-02 / Blue Rose

## Outcomes & Retrospective

Implementation is complete and installed through the repository's source launcher. The active configuration routes only Fable-backed main sessions to `driver`, routes task agents and fresh non-Fable sessions to `worker`, keeps `driver` on bank `omp`, and gives `worker` the isolated `omp-worker` bank with strict worker tags, project-only context, and an exact non-MCP tool boundary.

Validation receipts:

- 34 focused profile-transition, command, resolver, and lifecycle tests pass; 154 interactive and main-session regression tests pass.
- `bun run check` passes the coding-agent Biome and TypeScript gates.
- `bun run build` produces `packages/coding-agent/dist/omp`.
- The SDK smoke selects `reviewer`, renders `REVIEWER CONSTITUTION` exactly once with no driver/worker constitution leakage, reports bank `reviewer-bank`, and narrows `["read", "bash"]` to `["read"]`.
- The active-config smoke resolves Fable main to `driver`, task and GPT main to `worker`, and rejects Fable-driver transition to Opus.
- The active-driver prompt smoke retains the maintained role, tool policy, execution workflow, and delivery contract.
- The installed CLI emits a session header with `"agentProfile":"worker"` and completes a live GPT-5.6 worker turn; explicit `driver` plus GPT-5.6 fails in `assertModelAllowed` before a provider call.
- The provider-facing smoke switched a live Fable `driver` to GPT-5.6 `worker` and back to Fable `driver` in one process. Request dumps showed the worker omitted user-global `CLAUDE.md` and exposed its restricted 20-tool surface, while the driver restored user-global context and its own provider-specific tool surface; each transition wrote a distinct persisted profile header. The installed `~/.bun/bin/omp` source launcher independently completed the same driver-to-worker-to-driver transition and exited cleanly.

The critical design lesson is that identity isolation requires a selected constitution layered over—not substituted for—the maintained harness contract, and more than prompt composition alone. User-global context files, MCP server instructions, Hindsight scope, fallback mutation, and optional tool factories are independent ingress paths. The final profile owner closes all of them without duplicating prompt assembly, memory runtime, model switching, or permissions.

## Context and Orientation

`packages/coding-agent/src/agent-profiles.ts` validates named identity records, loads the selected constitution source, compiles model globs, and resolves ordered initial routes. `packages/coding-agent/src/sdk.ts` constructs that resolver, selects or restores one profile, filters context and tools, builds the provider-facing prompt, and starts the selected memory backend. `packages/coding-agent/src/session/session-tools.ts`, `turn-recovery.ts`, and `agent-session.ts` own model-transition preflight and prompt refresh. `packages/coding-agent/src/hindsight/backend.ts` computes Hindsight bank scope and aliases a child only when no distinct scope is requested. `packages/coding-agent/src/session/session-entries.ts` and `session-manager.ts` own durable session headers.

An agent profile is a named, validated configuration record. It has exactly one `prompt` literal, `promptFile`, or `useDefaultPrompt: true`; a Hindsight scope containing a non-empty bank ID and optional retain/recall tags; optional model globs; an optional exact tool allowlist; and optional project-only context filtering. A resolved profile contains loaded prompt text and immutable policy. An initial route matches `agentKind` and canonical `provider/model` with first-match semantics. A session without an explicit, persisted, or routed profile keeps the existing default behavior.

## Plan of Work

Rename the prompt-profile module and its settings to the agent-profile vocabulary. Validate all external settings once with ArkType, load every configured constitution source once, compile model globs once, and represent selection as a closed decision type: default, selected profile, or denied route. Resolve explicit and persisted IDs through the same owner.

In `createAgentSession`, select a profile after the startup model is known but before tools and prompt construction. A persisted profile on an existing session is authoritative; a conflicting explicit profile fails before mutation. Otherwise explicit selection precedes initial route selection. Persist the selected ID in the session header. Select the harness base through the existing explicit/discovered/default precedence, then layer exactly the selected profile constitution over it; discovered `SYSTEM.md` remains unavailable to profiled sessions, while an explicit SDK/CLI custom base composes without erasing profile identity. Store the profile ID and model validator in `AgentSession`; do not re-run routes on model changes.

Use the selected profile's optional tool list to narrow `options.toolNames` and activate the established `restrictToolNames` path before optional tool factories and MCP discovery. Filter context files to project roots when `projectContextOnly` is set. Pass the profile's Hindsight scope through `MemoryBackendStartOptions` and `SessionMemory`. In the Hindsight backend, alias a parent only when no profile scope is supplied or when the resolved scope is structurally identical. A child with a different scope owns a separate state, client, mental-model cache, recall state, and retain queue.

Persist the profile ID across new sessions and forks. Reject switching an already-running AgentSession to a session file whose profile differs. Legacy or newly created unprofiled sessions remain valid when the active AgentSession is also unprofiled.

For an interactive profile transition, resolve and validate the target profile and initial model before teardown. The slash command records a typed transition request and wakes the outer interactive loop without submitting a user message. The outer loop captures the selected model, configured thinking level, working directory, and additional workspace roots; shuts down the current mode without quitting the process; then creates a new `SessionManager`, re-resolves cwd-scoped prompt/config inputs, reloads extensions and their CLI flags, and calls `createAgentSession` with the selected profile. Provider session IDs and provider prompt-cache identities do not carry across the boundary. A new `InteractiveMode` then owns the terminal.

Disposing the old top-level session clears subagents and retires the current process-global lifecycle manager. The next session receives a fresh manager and persisted-subagent reviver factory rather than writing through the disposed singleton. The command is TUI-only because ACP hosts own their session lifecycle.

## Concrete Steps

Work from `packages/coding-agent`.

First run the narrow type check after the profile model compiles:

    bun run check:types

Then run the focused profile, model-transition, Hindsight, CLI parser, and session-manager tests named in the changed source’s existing neighboring suites. Once behavior is stable, run:

    bun run check

Finally exercise `createAgentSession` with three inline profiles. Observe that explicit selection chooses one constitution exactly once, a subagent route chooses another, the two Hindsight states name different banks, an out-of-policy model transition rejects before mutation, and the profile tool set cannot be widened by caller options.

## Validation and Acceptance

Acceptance requires all of the following observable behavior. A configuration containing `driver`, `worker`, and `reviewer` resolves all three independently. A top-level Fable route chooses `driver`; a task route chooses `worker`. The provider-facing prompt retains the maintained role, tool policy, execution workflow, and delivery contract; contains the selected constitution once; and contains no text from the other profiles. An explicit custom base composes with rather than erases the selected constitution. Resuming a session restores its persisted profile. A model fallback outside the profile’s allowed globs throws before changing the active model or prompt. A profile-scoped child Hindsight state does not alias a differently scoped parent and uses its configured bank and tags. A profile tool allowlist intersects caller tools and prevents extension/MCP widening through the existing restricted-session boundary. Existing sessions without a profile continue to load.

The focused tests and `bun run check` must exit zero. The SDK smoke must print the selected profile ID, a single constitution occurrence, the expected bank ID, and the narrowed tool names.

## Idempotence and Recovery

Profile construction performs only reads and pure validation. Hindsight bank creation remains idempotent through the existing `banksSet`. Session-header updates are atomic through `SessionManager`; retrying startup either observes the same persisted profile or fails before model/tool/provider mutation. If a focused test exposes a transition gap, repair the canonical model or session transition owner rather than adding a second callback path.

An interactive switch validates the target profile and model before closing the current session. If reconstruction nevertheless fails, the old transcript is already durably closed and remains resumable by its printed session ID; the process reports the failed target rather than silently restoring or substituting an identity. Re-running OMP and resuming either transcript is safe.

## Artifacts and Notes

The active operator configuration defines `driver` and `worker` directly through the same public settings surface exercised by tests and the SDK smoke.

## Interfaces and Dependencies

The resolved agent-profile module exports the profile, Hindsight scope, selection decision, and resolver interfaces plus one asynchronous constructor. It uses ArkType for boundary validation and `Bun.Glob` for prepared model matching, matching existing dependencies.

`CreateAgentSessionOptions` gains an optional `agentProfile` ID. `SessionHeader` and `NewSessionOptions` gain an optional persisted `agentProfile`. `MemoryBackendStartOptions` gains an optional resolved Hindsight scope. `AgentSession` receives the selected profile ID and one model-policy assertion callback. No new package dependency, registry, background service, or provider request is introduced.

Revision 2026-08-02: source verification confirmed every cited owner and command in the coding-agent package. The plan now specifies one eager load per configured constitution instead of an unearned lazy-loading path; this preserves the existing bounded startup cost and keeps selection pure.

Revision 2026-08-02 closeout: source verification reconfirmed every cited module, test file, package script, and public field. `MemoryBackendStartOptions.hindsightScope`, `SessionHeader.agentProfile`, `NewSessionOptions.agentProfile`, `AgentProfile.projectContextOnly`, `useDefaultPrompt`, and the model-policy callback all exist at the named owners; no cross-package dependency or phantom test target remains.

Revision 2026-08-02 interactive transition: source verification places command selection in `InteractiveMode`, the replacement loop in `main.ts`, and lifecycle renewal in `AgentLifecycleManager`. The transition is a fresh-session boundary inside one process, not an in-place profile mutation or shell relaunch.

Revision 2026-08-02 composition correction: runtime inspection showed the custom-prompt template omits OMP's maintained operational scaffold. Profile `prompt` and `promptFile` now compose as one selected system block over the normal base; `useDefaultPrompt: true` adds no constitution block. Focused coverage pins the maintained sections and explicit-custom-base composition.
