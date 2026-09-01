# Converge Memory Lifecycle on Upstream Owners

This ExecPlan is a living document. `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` are maintained throughout execution.

## Purpose / Big Picture

Reduce the maintained OMP fork's memory overlay by returning generic backend lifecycle and built-in tool dispatch to current official OMP owners while preserving the small behavior Rosalia values: Hindsight retain/recall provenance, per-project-tagged mental-model isolation, truthful profile-aware memory identity, exact caller-scoped `memory://` resolution, and durable pending writes.

After the cut, the public/backend substrate follows the official memory owners at the maintained merge base `65f79e76fcc89b96632fe86a598f314bd7cfc725`: official `MemoryBackend`, extension-facing `MemoryRuntimeContext { status, search, save }`, provider-specific built-in tools, provider-local live Hindsight aliases, and official terminal provider cleanup. The fork has no all-method `MemoryBackendRuntime`, capability matrix, generic mental-model controller, or generic retain/recall/reflect/edit result algebra.

Hindsight child operations follow the primary parent's live provider slot, while queued retains capture an immutable route when accepted. Mnemopi children refuse memory because its SQLite resources are parent-owned. No global live-agent scan remains.

## Progress

- [x] (2026-08-31) Measured direct memory overlay: 17 source paths, +1,790/-450, net +1,340.
- [x] (2026-08-31) Measured runtime/interface/provider upper bound: nine source paths, +1,236/-283, net +953.
- [x] (2026-08-31) Confirmed active configuration uses Hindsight, default `per-project-tagged` scope, and memory-enabled worker profiles.
- [x] (2026-08-31) Authored and mechanically source-verified the initial ExecPlan.
- [x] (2026-08-31) Ran three independent read-only audits. All found the direction viable and the initial plan unsafe until consumer, lifecycle, Mnemopi, queue, routing, and profile-denial closure was added.
- [x] (2026-08-31) Rewrote this plan once with adjudicated findings R1-R10.
- [x] (2026-08-31) Mechanically source-verified the revised plan and recorded the pre-implementation safety verdict.
- [x] (2026-08-31) Implemented the lifecycle convergence in the detached worktree.
- [x] (2026-08-31) Passed static checks and the 21-file focused suite (472 tests, 1,305 assertions).
- [x] (2026-08-31) Passed package build and built-binary smoke; independent `gpt-5.6-sol:xhigh` review accepted the convergence with no model fallback.
- [ ] Commit, publish, and advance the active detached checkout.

## Surprises & Discoveries

- Official OMP already owns the five-backend selector, local memory, Hindsight auto recall/retention/scoping, Mnemopi, Sharpshooter, mental-model commands, ordinary explicit memory tools, and extension status/search/save.
- Official `SessionMemory` already implements transition-time Hindsight/Mnemopi cleanup, rekey, and transcript reset through explicit provider branches. Official `AgentSession` separately owns terminal Hindsight queue drain, bounded Mnemopi consolidation/embed shutdown, and Sharpshooter extraction drain/release.
- Current `SessionMemory` is net one line smaller than official. Most extra mass is required all-method provider implementations and expanded runtime/tool vocabulary.
- Official Hindsight aliases copy remote routes, but the maintained fork already guarantees the stronger live-parent law. Provider-local session pointers preserve it without the removed registry scan; queued retains still capture their accepted route.
- Official `memory-backend/tool-names.ts` is a two-line canonical constant. The fork added capability projection to that owner; the file must be restored, not deleted.
- Current caller-scoped `memory://` routing fixes a real official first-hit bug when two live Mnemopi sessions contain the same ID. Preserve it without the generic identity ADT.
- Current profile `memory: false` gates startup, prompt injection, built-in tools, and compaction, but extension `ctx.memory` and `memory://` can still bypass the policy. The convergence must close that hole rather than preserve it.
- Both upstream and current Hindsight scope replacement have an enqueue-after-final-flush loss window. Safe convergence requires atomic queue retirement before terminal drain.
- Child aliases cannot safely copy a route or trust a stale parent object. They resolve the parent session's current primary state for startup and every later operation; accepted retains alone keep an immutable enqueue-time route.
- `memory://` authorization needs the caller's stable `SessionManager` ID plus exact effective profile permission on every path-capable tool. Provider session IDs rotate, and cwd fallback is unsafe when profiles differ.
- The Mnemopi embed worker is process-wide, not AgentSession-owned. Each Mnemopi state acquires an owner and only the last closing state terminates the worker.
- Cwd reload hooks are insufficient as the transition owner: they exist only while Hindsight is already active and global scope can compare equal while project provenance changes. Interactive and headless cwd moves consume any pending Hindsight rebuild, then apply the destination backend when that rebuild did not.
- The maintained cut remains based on `b44baf7a816545c8863e251ec25a4a73bb6578e3`. At final smoke, official `upstream/main` had advanced independently to `7523a2d7c64ca17cd9a7d9eae5dc9cf89e1419ff` (259 commits available); that later upstream-update campaign is outside this local convergence commit.

## Decision Log

- R1 — **Accepted:** official `MemoryBackend` and three-method `MemoryRuntimeContext` are the canonical registry/query surface. Remove fork-only runtime/capability/mental-model/explicit-operation algebras.
  Date: 2026-08-31.

- R2 — **Accepted:** restore official built-in provider dispatch and `createIf` admission for `learn`, `retain`, `recall`, `reflect`, and `memory_edit`. Preserve profile denial outside those factories.
  Date: 2026-08-31.

- R3 — **Corrected:** restore `memory-backend/tool-names.ts` to upstream's `MEMORY_BACKEND_TOOL_NAMES`; do not delete the file.
  Evidence: official SDK imports it; audit lanes 2 and 3 independently found the initial plan wrong.
  Date: 2026-08-31.

- R4 — **Revised during review:** Hindsight aliases resolve operations through the parent's live provider slot, while queued retains snapshot their route at enqueue. Mnemopi children explicitly refuse memory. No registry-wide scan.
  Date: 2026-08-31.

- R5 — **Accepted:** preserve Hindsight provenance at provider entrances. Metadata is captured at enqueue/automatic-retain time, never synthesized at flush. Recall formatting remains bounded and excludes credential-shaped metadata.
  Date: 2026-08-31.

- R6 — **Strengthened during review:** route `memory://` by exact session file first, then stable `SessionManager` ID. Use cwd only for contextless legacy callers; an exact-ID miss and effective profile denial fail closed. Propagate identity and permission through read/glob/grep/AST/Bash path resolution. Do not restore registry-wide first-hit Mnemopi lookup.
  Date: 2026-08-31.

- R7 — **Strengthened during review:** interactive and headless cwd completion await accepted old-route retains, consume the coalesced Hindsight scope task, and apply the destination backend whenever that task did not. This covers backend cutovers, global-scope project provenance, and rollback.
  Date: 2026-08-31.

- R8 — **Accepted:** full profile memory denial means no backend start, prompt/compaction context, built-in tool, extension `ctx.memory`, or `memory://` access. Close existing extension/internal-URL holes.
  Date: 2026-08-31.

- R9 — **Strengthened during review:** retain official provider-specific disposal, but make the process-wide Mnemopi embed worker reference-counted and terminate it only after the last Mnemopi state closes. Hindsight drains atomically; Sharpshooter drains/releases; generic-runtime disposal is removed.
  Date: 2026-08-31.

- R10 — **Accepted API break:** fork-only public TypeScript types/methods are removed: `MemoryBackendRuntime`, `MemoryBackendCapabilities`, `MemoryBackendIdentity`, expanded `MemoryRuntimeContext` methods, `MemoryBackend.runtime/capabilities`, generic result families, and `ToolSession.getMemoryRuntime/getAgentSession`. Official exported contracts remain. No in-repo external extension uses removed methods; out-of-repo consumers must migrate to official status/search/save or built-in tools.
  Date: 2026-08-31.

- R11 — **Quantitative prediction falsified and threshold revised:** the reviewed production delta is +1,260/-1,816, a 556-line net reduction rather than the predicted 750–900 or 650 floor. The independent review exposed correctness obligations absent from the estimate: stable caller authorization across every path tool, live/stale child-route handling, last-owner Mnemopi worker shutdown, and awaited destination-backend cwd cutovers. Reconsideration retained the cut because it still deletes the generic semantic owner and all of its callers; deleting another 94 lines would mean weakening those verified contracts rather than removing a second owner. Correctness and single ownership supersede the forecast.
  Date: 2026-08-31.

## Outcomes & Retrospective

The fork-only generic runtime/capability/result owner and every in-repo caller are removed. The final production source delta is +1,260/-1,816 across 41 files: 556 net lines removed. The quantitative prediction was falsified and adjudicated in R11; the retained lines implement review-found correctness contracts rather than a second semantic owner.

Hindsight now owns live child routing, enqueue-time immutable retain routes, provenance, bank creation, atomic queue retirement, and cwd/backend cutovers. Exact caller identity and profile permission reach every path-capable internal-URL entrance. Mnemopi children receive no parent state, and the shared embed worker closes only after its last state owner. Initial backend startup, runtime changes, cwd moves, and disposal share the serialized `SessionMemory` transition.

Verification: `bun run check` passed; the final 21-file focused suite passed 472/472 tests with 1,305 assertions; `bun run build` passed; `dist/omp --smoke-test` returned `smoke-test: ok`; `dist/omp update --check` succeeded and reported 259 later upstream commits. The earlier canonical full-suite run had only the two failures reproduced byte-for-byte on unchanged base (`config-value-fd-inheritance`, `issue-983-multi-file-extension`); the broker snapshot timeout passed standalone on both candidate and base.

A fresh `openai-codex/gpt-5.6-sol:xhigh` review, with no `model_change`, accepted the convergence after its concrete findings were integrated. The final restricted-worker grant correction was then exercised by its two direct suites and the complete focused suite.

## Context and Orientation

Maintained checkout: `/Users/bluerose/Developer/omp-hindsight-per-prompt` at `b44baf7a816545c8863e251ec25a4a73bb6578e3`.

Detached implementation worktree: `/Users/bluerose/Developer/omp-memory-minimal`.

Official comparison ref: `upstream/main` at `65f79e76fcc89b96632fe86a598f314bd7cfc725`, the maintained HEAD's merge base.

Direct source census paths:

- `hindsight/{backend,state,client,content,mental-models,bank}.ts` and `hindsight/seeds.json`
- `memory-backend/{types,runtime,local-backend,off-backend,tool-names,index}.ts`
- `mnemopi/{backend,state}.ts`
- `sharpshooter/backend.ts`
- `internal-urls/memory-protocol.ts`

Official lifecycle/tool owners:

- `packages/coding-agent/src/memory-backend/types.ts`: `MemoryBackend`, `MemoryRuntimeContext`, status/search/save contracts.
- `packages/coding-agent/src/memory-backend/runtime.ts`: `createMemoryRuntimeContext`, `createSessionMemoryRuntimeContext`.
- `packages/coding-agent/src/session/session-memory.ts`: transition-time provider lifecycle and transcript reset.
- `packages/coding-agent/src/session/agent-session.ts`: terminal provider drain/disposal.
- `packages/coding-agent/src/tools/{learn,memory-retain,memory-recall,memory-reflect,memory-edit}.ts`: explicit provider dispatch.
- `packages/coding-agent/src/tools/index.ts`: backend-specific tool admission.

Narrow fork behavior owners:

- `packages/coding-agent/src/hindsight/client.ts`: `MemoryProvenanceMetadata` and rich `RecallResult`.
- `packages/coding-agent/src/hindsight/state.ts`: enqueue-time/automatic-retain provenance and atomic queue retirement.
- `packages/coding-agent/src/hindsight/content.ts`: bounded recall provenance rendering.
- `packages/coding-agent/src/hindsight/mental-models.ts`: tagged-seed refusal; current full-mode/token settings in `seeds.json` remain.
- `packages/coding-agent/src/internal-urls/memory-protocol.ts`: caller/session-file isolation and profile denial.
- `packages/coding-agent/src/session/identity.ts`: profile identity plus minimal memory projection.

## Proposed Interfaces and Cutover

1. Restore official `MemoryBackend`, `MemoryRuntimeContext`, `MemoryBackendStartOptions`, and ordinary status/search/save types. Remove fork-only all-method runtime/capability/mental-model/explicit-operation types and `MemoryBackend.runtime()`.
2. Restore official `memory-backend/{runtime,local-backend,off-backend,index}.ts` and the two-line `tool-names.ts` constant.
3. Restore official provider implementations in `hindsight/backend.ts`, `mnemopi/backend.ts`, and `sharpshooter/backend.ts`; reapply only the narrow provider behavior listed above.
4. Restore official built-in tool dispatch in `tools/{learn,memory-retain,memory-recall,memory-reflect,memory-edit}.ts`. Restore only memory hunks in mixed `tools/index.ts`, preserving prompt tool masks, task/hub pairing, and ask behavior.
5. Restore official direct `/memory mm` Hindsight dispatch in `modes/controllers/command-controller.ts`.
6. Rebase `session/session-memory.ts`, `session/agent-session.ts`, `session/agent-session-types.ts`, `modes/{interactive-mode,print-mode}.ts`, and `sdk.ts` onto complete official transition and terminal-disposal owners. Preserve profile-memory denial, cwd-move rebind, provider prompt refresh, and current non-memory behavior.
7. Carry `parentHindsightSessionState` through `sdk.ts`, `task/executor.ts`, `task/structured-subagent.ts`, `task/persisted-revive.ts`, and `vibe/runtime.ts`. Hindsight uses it to bind a provider-local live-parent alias; Mnemopi child startup refuses state.
8. Restore official direct provider state getters on `ToolSession` and remove `getAgentSession/getMemoryRuntime`. Preserve official extension `MemoryRuntimeContext` wiring in `extensibility/extensions/{types,runner}.ts`; gate the SDK getter to `undefined` when the effective profile disables memory.
9. Replace generic `MemoryBackendIdentity` with a session-owned projection:
   - `off`;
   - `local` active;
   - `sharpshooter` active;
   - `mnemopi`: configured-not-started or active;
   - `hindsight`: configured-not-started or active { bank, project, scope, tags };
   - unavailable/not-started before session construction.
   Derive from selected settings and provider-owned current states. `mnemopi.banks` is removed.
10. Preserve caller-scoped `memory://` lookup without generic identity: exact session file first, stable `SessionManager` ID second, then that caller's selected backend/state only. A supplied exact identity that resolves no live caller fails closed; cwd fallback exists only when neither exact identity is supplied. Reject when effective profile memory is disabled.
11. Make Hindsight queue retirement atomic: close/refuse intake, drain the captured queue, then detach/dispose. Enqueue racing retirement must either land before the drain or receive a typed/ordinary error; it may never disappear or cross routes.
12. Update generated-style tool docs to official direct-dispatch architecture and remove every deleted symbol reference.

## Complete Caller and Collision Closure

Production paths to edit or inspect:

- `packages/coding-agent/src/memory-backend/{types,runtime,index,tool-names,local-backend,off-backend}.ts`
- `packages/coding-agent/src/hindsight/{backend,state,bank,client,content,mental-models}.ts`, `hindsight/seeds.json`
- `packages/coding-agent/src/mnemopi/{backend,state}.ts`
- `packages/coding-agent/src/sharpshooter/backend.ts`
- `packages/coding-agent/src/internal-urls/memory-protocol.ts`
- `packages/coding-agent/src/modes/controllers/command-controller.ts`
- `packages/coding-agent/src/modes/{interactive-mode,print-mode}.ts`
- `packages/coding-agent/src/session/{agent-session,agent-session-types,identity,session-memory,session-tools,session-maintenance}.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/tools/{index,learn,memory-edit,memory-recall,memory-reflect,memory-retain}.ts`
- `packages/coding-agent/src/task/{executor,structured-subagent,persisted-revive}.ts`
- `packages/coding-agent/src/vibe/runtime.ts`
- `packages/coding-agent/src/extensibility/extensions/{types,runner}.ts` (official contract inspection/typecheck; edit only for profile denial if SDK gating is insufficient)
- `packages/coding-agent/src/modes/components/footer.ts` and `slash-commands/builtin-session.ts` (identity projections; inspect, avoid incidental edits)
- `docs/tools/{memory_edit,recall,reflect,retain}.md`

No deleted symbol may remain anywhere in production, tests, or active docs.

## Safety Proof and Acceptance

### Required behavior

1. Explicit `learn`/`retain` and automatic session retention preserve bounded source/session/agent/profile/model/project/cwd metadata captured before queueing.
2. Explicit recall renders bounded fact/document/tag/origin provenance, omits credential-shaped metadata, and ensures the target Hindsight bank exists before first recall when startup has not done so.
3. Tagged project seeds are skipped when `per-project-tagged` scope has no retain tags; full-mode/token seed settings remain unchanged.
4. `memory: false` starts no backend, injects no base/per-turn/compaction memory, admits no memory tools, exposes no extension `ctx.memory`, and rejects `memory://`.
5. Hindsight child operations follow parent bank/tag/project replacements. Each accepted retain keeps its enqueue-time route. Mnemopi children never receive parent-owned resources.
6. Hindsight retirement is atomic against concurrent enqueue. Pending retains drain before terminal close. Cwd moves rebind project-scoped memory before the next write.
7. Official bounded Mnemopi consolidation/embed shutdown and Sharpshooter extraction drain/release are restored.
8. Minimal identity reports disabled, configured-not-started, or active backend truthfully; active Hindsight includes bank/project/scope/tags.
9. Exact session-file-first `memory://` routing and caller bank isolation remain.
10. Official extension status/search/save and built-in memory tool contracts remain; dropped fork-only extension methods are absent and documented as an accepted API cut.
11. No global AgentRegistry scan exists solely for memory alias movement or child prompt refresh.

### Focused verification

Run from repository root:

- Provenance and Hindsight:
  `bun test packages/coding-agent/test/hindsight-provenance.test.ts packages/coding-agent/test/hindsight-content.test.ts packages/coding-agent/test/hindsight-mental-models.test.ts packages/coding-agent/test/hindsight-backend.test.ts`
- Backends, tools, URLs:
  `bun test packages/coding-agent/test/memory-tools.test.ts packages/coding-agent/test/memory-backend-resolve.test.ts packages/coding-agent/test/agent-session-memory-backend.test.ts packages/coding-agent/test/internal-urls/memory-protocol.test.ts packages/coding-agent/test/sharpshooter-backend.test.ts packages/coding-agent/test/tools/index.test.ts`
- Profiles/extensions/autolearn:
  `bun test packages/coding-agent/test/system-prompt-profiles-sdk.test.ts packages/coding-agent/test/identity-surfaces.test.ts packages/coding-agent/test/extensions-runner.test.ts packages/coding-agent/test/autolearn-learn-local.test.ts packages/coding-agent/test/autolearn-tools-gating.test.ts packages/coding-agent/test/sdk-autolearn-active-tools.test.ts`
- Lifecycle/spawn:
  `bun test packages/coding-agent/test/agent-session-dispose-concurrent.test.ts packages/coding-agent/test/agent-session-message-pipeline.test.ts packages/coding-agent/test/task/persisted-revive.test.ts packages/coding-agent/test/silent-abort-print-mode.test.ts`

Add focused behavioral tests only for currently uncovered changed contracts:

- explicit `learn` and `retain` provenance through queue flush;
- model-visible recall provenance;
- atomic enqueue-versus-retire;
- Hindsight live child route plus enqueue-time project label capture;
- Mnemopi stale-parent refusal/live lookup;
- post-cwd-move Hindsight project rebinding;
- full profile denial for extension memory and `memory://`;
- direct `/memory mm` dispatch.

Then:

- `bun run check` from `packages/coding-agent`.
- `bun run build` from `packages/coding-agent`.
- Independent code review against this plan and official diff.
- Actual source-linked `omp --smoke-test` and `omp update --check` after integration.

### Quantitative prediction

Prediction (falsified): 750–900 net production lines, with a 650-line reconsideration floor. The reviewed implementation measures +1,260/-1,816, or 556 net lines removed. R11 records the required reconsideration: correctness repairs consumed 94 lines beyond the floor, while the generic runtime/capability/result owner and every caller remain deleted. The quantitative forecast is no longer an acceptance gate.

### Stop conditions

- Stop if provenance requires reintroducing generic retain/recall/reflect wrappers.
- Stop if profile denial is weaker on any startup, prompt, compaction, built-in tool, extension, or internal-URL surface.
- Stop if Hindsight queue retirement can lose an accepted item.
- Stop if Mnemopi child access can reach parent-closed resources.
- Stop if exact caller/session-file memory routing or cwd rebinding is lost.
- Stop if official terminal disposal is incomplete.
- Stop if spawn wiring is only compile-checked; require positive Hindsight and Mnemopi child tests.
- Stop if a sub-threshold result leaves the generic runtime/capability/result owner or weakens a required behavior. R11 adjudicates the measured sub-threshold result.

## Idempotence and Recovery

All production edits occur in the detached worktree. The active checkout remains untouched until a validated commit exists. Official file materialization is deterministic from `upstream/main`; narrow retained behavior is explicit. On failure, remove the detached worktree and retain `b44baf7a81`. Never stash, reset, or switch branches.

## Artifacts and Notes

- Baseline: `~/.omp/agent/scratch/2026-08-31-omp-maintenance-surface.md`.
- Value audit: `~/.omp/agent/scratch/2026-08-31-omp-memory-overlay-value.md`.
- Audit lanes: `~/.omp/agent/scratch/2026-08-31-omp-memory-audit-lane-{1,2,3}.md`.
- Initial in-process Opus lanes failed before research because the long-lived process had stale profile-schema state; fresh-process Sol audits completed on the configured model with no model changes.
