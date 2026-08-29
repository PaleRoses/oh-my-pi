# Make AI and Catalog Upstream-Owned

This ExecPlan is a living document. `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` are updated during execution.

## Purpose / Big Picture

Replace the maintained fork's accumulated provider, authentication, registry, streaming, usage, and model-catalog divergence with upstream's current complete `packages/ai` and `packages/catalog` closures. After the cut, upstream owns every generic mechanism in those packages. The fork retains account-selection and model-role policy outside these packages and one explicit provider overlay for official Anthropic server compaction, which upstream does not yet implement.

Success is observable when upstream source, tests, package metadata, and catalog generators are present; package checks and focused provider/auth/catalog suites pass; account-selection/fallback receipts pass; and the only `packages/ai` source differences from upstream are the named Anthropic compaction overlay files.

## Progress

- [x] (2026-08-28) Measured current divergence and snapshotted the dirty checkout.
- [x] (2026-08-28) Materialized upstream `packages/ai` and `packages/catalog` source, tests, metadata, and generators.
- [x] (2026-08-28) Reapplied only the five-file official Anthropic server-compaction provider overlay and its receipt.
- [x] (2026-08-28) Regenerated the lockfile, removed stale nested registry copies, and repaired the two upstream consumer dependencies without recreating compatibility owners.
- [x] (2026-08-28) Verified AI, catalog, account-selection, provider routing, compaction, static checks, frozen install, build, and CLI catalog surfaces.

## Surprises & Discoveries

- `packages/ai/src` differs from upstream in 36 paths: four missing and 32 changed. `packages/catalog/src` differs in 13 paths: two missing and 11 changed.
- The corresponding test trees have eight missing and 25 changed AI tests, plus three missing and ten changed catalog tests.
- Upstream has 113 AI/catalog maintenance commits since merge base `4854db856c20`, covering OAuth, provider registries, stream errors, replay, multimodal outputs, usage quotas, model discovery, and cache correctness.
- The active generic retry/provider dependency files installed during the previous substrate wave are already byte-identical to upstream. The only intentional non-upstream provider implementation is official Anthropic server compaction in `anthropic.ts`, `anthropic-wire.ts`, `transform-messages.ts`, `types.ts`, and `utils.ts`.
- Package-local `node_modules/@oh-my-pi/pi-ai` and `pi-catalog` directories were stale registry copies at version 18.0.4. They masked the updated workspace sources and caused cascading module/export failures. Removing those derived copies restored canonical workspace resolution; frozen install remains green.
- Upstream package manifests are 18.0.9 while the maintained fork's workspace catalog remains 18.0.4. The package manifests therefore match upstream semantically except for the local version field; bumping two packages alone would route sibling imports back to registry packages instead of this source tree.
- The complete AI suite runs 4,267 non-skipped tests concurrently. Three Bedrock tests consistently exceed their five-second per-test deadline only in the 392-file fan-out; the same six-test contract set passes in 102 ms when isolated.

## Decision Log

- Decision: Treat the whole AI/catalog package closure, not selected provider files, as the integration unit.
  Rationale: Provider source depends on package exports, registries, tests, generated catalog policy, schemas, and model metadata. Partial copying recreates the missing-dependency failure seen in the Git TUI cut.
  Date: 2026-08-28.

- Decision: Keep account pins, fallback order, and model-role/profile selection outside AI/catalog as fork policy; use upstream auth broker, gateway, credential store, registry, and selection mechanisms.
  Rationale: Mechanism is commodity infrastructure; policy is differentiated product behavior.
  Date: 2026-08-28.

- Decision: Preserve official Anthropic server compaction as one audited provider overlay until it lands upstream.
  Rationale: Deleting it loses an established fork contract. Reimplementing it outside the provider would duplicate Anthropic wire handling and telemetry.
  Date: 2026-08-28.

- Decision: Keep AI/catalog package versions at 18.0.4 while adopting all other upstream package metadata.
  Rationale: The fork's workspace catalog is 18.0.4. A partial 18.0.9 bump makes Bun install nested registry copies and bypasses the edited workspace source; the version field is release coordination, not provider mechanism.
  Date: 2026-08-28.

## Outcomes & Retrospective

AI and catalog are now upstream-owned closures. All 361 upstream AI source files are present; only five source files differ for official Anthropic server compaction. All 401 upstream AI tests match byte-for-byte, with one additional Anthropic receipt. All 59 catalog source files and all 94 catalog tests match upstream exactly. AI/catalog README, changelogs, and generators match upstream; each package manifest differs only in the fork-coordinated 18.0.4 version field.

Verification: AI static check green; catalog static check green; agent and coding-agent static checks green; catalog suite 787/0; AI suite 4,264 pass and 332 skip with three fan-out-only Bedrock timeouts, followed by the exact six Bedrock contracts at 6/0; fork account/model-role policy 367/0; Anthropic provider receipt 3/0; agent compaction 104/0; frozen lockfile install green; coding-agent build green. The built CLI reports version 18.0.4, `models --help` and `usage --help` launch, and `models --json` returns 91 catalog entries.

No generic provider/auth/registry/usage implementation remains fork-owned. The remaining AI overlay is one named upstream contribution candidate: official Anthropic server compaction. A ten-file patch against fetched upstream is stored at `~/.omp/agent/scratch/2026-08-28-anthropic-server-compaction-upstream.patch`; `patch --dry-run -p1` succeeds against an upstream fixture. Account pins, fallback order, model roles, and Hindsight provenance remain outside AI/catalog as fork policy.

## Context and Orientation

The target checkout is `/Users/bluerose/Developer/omp-hindsight-per-prompt`. Upstream is fetched at `c58cb36a73cc49626bb50d9a177644328d2bc120`; fork HEAD is `c020a77c7612627f1e72c00f08d0fb2f3918d0f8`; merge base is `4854db856c20e000a3760d793c56d78065dcf83f`.

Generic AI mechanisms live under `packages/ai/src`: provider transports, auth broker/gateway/storage, registries and OAuth, streaming, replay, usage, and common types. Model inventory and compatibility live under `packages/catalog/src` and its generators. Fork account policy is configured and consumed from coding-agent profiles/settings; Hindsight provenance is a session/memory concern, not provider compatibility.

The Anthropic overlay is carried by:

- `packages/ai/src/providers/anthropic.ts`
- `packages/ai/src/providers/anthropic-wire.ts`
- `packages/ai/src/providers/transform-messages.ts`
- `packages/ai/src/types.ts`
- `packages/ai/src/utils.ts`
- `packages/ai/test/anthropic-server-compaction.test.ts`
- `packages/agent/src/compaction/anthropic.ts` and its dispatch integration

## Plan of Work

Capture the four-file Anthropic overlay against fetched upstream in memory. Replace the complete upstream-owned AI/catalog package trees and metadata with the fetched upstream versions, removing stale files and adding missing files. Restore only the overlay source and test. Preserve coding-agent account policy and all files outside the named packages.

Run package checks before behavioral suites. Repair only real integration seams exposed by the compiler, preferring upstream dependency closures over local aliases. Regenerate catalog data only through its existing scripts when required. Then run focused upstream AI/catalog tests, auth/account selection and fallback receipts, Anthropic compaction receipts, package suites, coding-agent static checks/build, and CLI smoke.

## Validation and Acceptance

Acceptance requires:

1. Tree audit: AI/catalog source and tests match upstream except the four-file Anthropic overlay.
2. `bun run check` passes in `packages/ai`, `packages/catalog`, and `packages/coding-agent`.
3. Upstream provider/auth/catalog changed-contract tests pass.
4. Fork account pin, fallback, model-role, and Anthropic server-compaction receipts pass.
5. Coding-agent binary builds and `dist/omp --help` launches.
6. No pre-cut dirty path disappears, no conflict markers remain, and nothing is staged or committed.

The unfiltered coding-agent suite is not an acceptance gate: the immediately preceding attempt exceeded 1,800 seconds. Focused changed-contract suites and package checks are the deterministic evidence.

## Idempotence and Recovery

Pre-cut status and text patch receipts live in `~/.omp/agent/scratch/2026-08-28-omp-ai-catalog-pre-*`. The preceding full binary snapshot remains `~/.omp/agent/scratch/2026-08-28-omp-upstream-substrate-pre-worktree.patch`. All replacement content is recoverable from `FETCH_HEAD`; the Anthropic overlay is retained in kernel variables before replacement.
