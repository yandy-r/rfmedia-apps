# Task Structure Analysis: lidarr-similar-artist-discovery

## Executive Summary

Issue #203 should be implemented as two serially joined vertical slices: an independently usable
Last.fm discovery path, followed by an exact foreign-ID `artist-add` plan/apply path. The safe
parallel foundations are provider contracts, scheduler error handling, Lidarr facade additions,
and v2 plan contracts. They converge first at the read-only action and later at the add-plan/apply
integration.

Most tasks should own one source/test pair or at most three tightly coupled files. Keep one owner
for each aggregation point (`commands/lidarr.ts`, `types/lidarr-plan.ts`, `plan-engine.ts`,
`apply.ts`, and `templates.spec.ts`) and serialize later edits to those files. Generated Lidarr
source is read-only: consume the already committed root-folder and artist-create operations through
the handwritten facade, and strengthen only the offline generator and generated-contract tests.

The critical path is:

```text
discovery contracts -> provider action -> read-only command
Lidarr facade -> foreign-ID plan contract -> artist-add registry
  -> plan producer + apply reconciliation -> discover handoff
  -> completions/docs -> integrated verification
```

Tests should prove only the new trust and mutation boundaries. Do not duplicate the existing broad
plan/apply matrices for every output format or failure permutation.

## Recommended Phase Structure

### Phase 0 — Baseline and Contract Freeze

- **T00 — Baseline audit (no owned files):** Confirm the issue-203 worktree, preserve all existing
  planning artifacts, record focused commands, and verify that generated Lidarr files are clean.
- **T01 — Public discovery contracts:** Own
  `packages/rfmedia-cli/src/types/discovery.ts` and
  `packages/rfmedia-cli/src/types/index.ts`. Freeze recommendation, attribution, execution, and
  handoff unions with omitted optional fields and immutable values.
- **T02 — Discovery configuration:** Own
  `packages/rfmedia-cli/src/types/config.ts`,
  `packages/rfmedia-cli/src/lib/config.ts`, and
  `packages/rfmedia-cli/src/lib/config.test.ts`. Add the exact optional
  `discovery.lastfm.{apiKey,timeoutMs}` shape, template compatibility, bounds, unknown-key
  rejection, and secret-safe errors. Explicitly test the repository's eager template-resolution
  behavior rather than claiming credentials are invocation-lazy if they are not.

T01 and T02 may run in parallel after T00.

### Phase 1 — Parallel Trust-Boundary Foundations

- **T03 — Fixed Last.fm boundary:** Own new
  `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` and its colocated test. Implement the sole
  Last.fm Fetch owner, fixed HTTPS origin/method, redirect rejection, caller-plus-timeout
  cancellation, 1 MiB/4 KiB body bounds, fatal decoding, logical-error parsing, safe
  `Retry-After`, atomic strict projection, source URL validation, key redaction, and no retry
  loop. Critical tests cover fixed request construction, HTTP-200 logical errors, auth versus
  transient/rate-limit failures, abort/timeout, malformed/oversized input, URL/MBID/similarity
  rejection, and attributed empty success.
- **T04 — Scheduler structural error seam:** Own
  `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`. Replace the internal
  `instanceof LidarrError` dependency with a narrow safe scheduled-error view and add
  `discovery-provider-unavailable` only to execution metadata. Prove retry occurs only for
  idempotent discovery work, honors bounded safe delay, stops on abort/auth/config/invalid data,
  and never feeds Lidarr circuits or deferred mutation.
- **T05 — Lidarr add domain projections:** Own
  `packages/rfmedia-cli/src/types/lidarr.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/types.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`. Add generated-independent root-folder and
  artist-add inputs plus bounded frozen projectors; keep writable generated DTOs private.
- **T06 — Offline generated-client contract:** Own
  `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`,
  `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`, and
  `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`. Pin the already present
  `getApiV1Rootfolder` and `postApiV1Artist` operations, request envelopes, methods, and paths.
  Do not refresh OpenAPI or edit anything under `src/lib/lidarr/generated/`.

T03, T04, T05, and T06 have disjoint ownership and may run concurrently after their applicable
contracts (T01/T02) settle.

### Phase 2 — Lidarr Facade and Read-Only Discovery

- **T07 — Narrow facade and typed mock:** Own
  `packages/rfmedia-cli/src/lib/lidarr/client.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`, and
  `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`. Add exact lookup/read-back,
  `listRootFolders()`, and `addArtist()` while constructing the minimal writable body only from an
  authoritative Lidarr lookup plus sealed policy. Test operation choice, lookup correlation,
  exact conservative body, abort forwarding, malformed results, and sanitized ambiguity.
- **T08 — Resilience parity:** Own
  `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`. Forward every new facade method;
  allowlist only safe reads and prove `addArtist()` has no in-place retry, stale fallback, or
  caching.
- **T09 — Exact root-folder selection:** Own
  `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/artist-selection.test.ts`. Add ID-or-exact-path resolution,
  positive-ID/path validation, and missing/ambiguous failures without weakening current profile
  selection behavior.
- **T10 — Read-only discovery action:** Own new
  `packages/rfmedia-cli/src/actions/lidarr/discover.ts` and its test. Validate before dependency
  resolution, run one idempotent task in the existing `discovery` lane, preserve provider order,
  remove the resolved seed, deduplicate MBID-first/first-win, assign visible ranks, and return
  mandatory attribution/execution metadata. Prove exactly one provider call and zero Lidarr
  resolution/calls on the ordinary path, including empty success and cancellation.
- **T11 — Read-only command surface:** Own new
  `packages/rfmedia-cli/src/commands/lidarr-discover.ts`,
  `packages/rfmedia-cli/src/commands/lidarr.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`. Register the leaf, validate exact grammar
  before lazy action import, keep human output on stderr and machine output on stdout, and emit a
  fixed attributed CSV summary row even for zero recommendations. Prove `--artist`, `--limit`, and
  `--no-autocorrect`, absence of `--yes`/stale/provider-key flags, redaction, and JSON/YAML/CSV
  structure.

T07 depends on T05 and T06; T08 depends on T07; T09 depends on T05. T10 depends on T01–T04. T11
depends on T10. The facade lane (T07–T09) may run beside the read-only action/command lane.

### Phase 3 — Foreign-ID Plan Contract and Operation Semantics

- **T12 — Strict `artist-add` plan family:** Own
  `packages/rfmedia-cli/src/types/lidarr-plan.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`. Add a kind-first v2
  `foreign-artist-id` selection/entry, expected-absence and desired-state contracts, provenance,
  root/profile references, foreign-ID history/results/failures, exact-key parsing,
  canonicalization, checksum/idempotency correlation, and old-artifact compatibility. Never use
  `artistId: 0`; keep the v2 discriminator and prove tamper rejection plus byte-for-byte existing
  v1/v2 acceptance.
- **T13 — Registry-owned artist-add behavior:** Own
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` and a focused new
  `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`. Register one
  medium-risk, expected-absence operation with fixed unmonitored/no-search policy, explicit
  resource references, stable idempotency material, absence/presence classification, dispatch,
  and verification. Widen non-deferable typing to include `artist-add` while leaving
  `createLidarrMutationExecutors()` without an add executor.
- **T14 — Add-plan producer:** Own new
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` and its test. From one validated
  visible recommendation, require a canonical MBID before Lidarr I/O; perform fresh exact lookup,
  complete-library absence, root-folder, quality-profile, and metadata-profile reads; return an
  already-present no-op or securely write one origin-bound sealed plan. Prove no artifact on
  missing identity/resource, ambiguity, existing artist, or read failure.

T12 follows T01. T13 follows T07, T09, and T12. T14 follows T08, T09, and T13.

### Phase 4 — Apply-Time Revalidation and Ambiguous-Dispatch Recovery

- **T15 — Foreign-target/resource preflight:** Own
  `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts`, and a focused new
  `packages/rfmedia-cli/src/actions/lidarr/apply-resources.test.ts`. Add root-folder catalogs and
  foreign-ID target shapes; route by operation kind before numeric narrowing. Re-resolve all
  sealed resources and classify exact existing desired state as satisfied, absence as ready, and
  conflicting identity/policy as drift.
- **T16 — Dedicated add executor:** Own new
  `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`, its focused test,
  and `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`. Persist
  possible-dispatch evidence keyed by MBID before POST, submit one
  `metadata-dependent`/`idempotent:false` task, and reconcile by fresh exact MBID read-back.
  Presence with the sealed postcondition proves success; inconclusive absence/mismatch is
  uncertain and stops admission. Never retry, defer, or blindly resume the POST.
- **T17 — Apply orchestration integration:** Own
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`. Integrate kind-first preflight,
  claim/history/resume, foreign-ID sorting/failures/results, resource revalidation, and the
  dedicated executor while preserving existing approval, checksum, origin, dry-run, and other
  operation behavior. Critical cases are already-present satisfaction, apply-time drift,
  lost-response verified success, unresolved uncertainty, history/claim failure, stop-admission,
  and proof that no deferred executor is created.

T15 follows T13. T16 follows T13 and T15. T17 follows T15 and T16. These tasks are intentionally
serial around the apply contracts; do not split `apply.ts` among parallel owners.

### Phase 5 — Handoff, Presentation, Completion Parity, and Architecture Gates

- **T18 — Discovery-to-plan handoff and action exports:** Own
  `packages/rfmedia-cli/src/actions/lidarr/discover.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts`, and
  `packages/rfmedia-cli/src/actions/lidarr/index.ts`. Add `--add` orchestration only after a
  complete discovery result and visible-rank/MBID validation. Preserve discovery success when the
  Lidarr handoff fails, and prove the action can only create a plan, never call POST.
- **T19 — Add handoff CLI and apply presentation:** Own
  `packages/rfmedia-cli/src/commands/lidarr-discover.ts`,
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`. Add conditional `--add`, root/profile, and
  plan-file grammar; display Last.fm attribution, MBID, fixed policy, plan identity/checksum/path,
  next command, foreign-ID apply results, and uncertainty recovery. Continue to reject `--yes`
  and direct mutation on `discover`.
- **T20 — Static Bash/Zsh/Fish completions:** Own
  `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`. Add the exact same static `discover`
  leaf and options to all shells, with no config/client/network lookup.
- **T21 — Completion parity gate:** Own
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`. Pin identical hierarchy,
  options, argument-taking flags, help order, and side-effect-free generation across Bash, Zsh,
  and Fish.
- **T22 — Architecture ownership gate:** Own
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`. Add the exact Last.fm module
  as a distinct single Fetch owner and `addArtist` as an operation-owned mutation. Prove fetches in
  commands/actions/second provider modules, generated imports outside `client.ts`, handwritten API
  paths, and mutation calls outside the approved owner fail.

T18 follows T14 and T17. T19 follows T18. T20 follows the final flag freeze in T19; T21 follows
T20. T22 follows T03, T07, T13, and T16.

### Phase 6 — Documentation, ROADMAP, and Verification

- **T23 — Canonical feature and safety docs:** Own new
  `packages/rfmedia-cli/docs/features/lidarr-discovery.md`,
  `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, and
  `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`. Document Last.fm attribution and
  terms date, provider-only operation, exact add-plan/apply workflow, non-retry/non-defer recovery,
  and data/secret minimization.
- **T24 — Configuration and user discovery docs:** Own
  `rfmedia.example.yaml`, `packages/rfmedia-cli/README.md`, and `docs/README.md`. Add the
  template-backed key, timeout, exact command examples, no-cache/no-direct-add behavior, and feature
  guide index.
- **T25 — Release and roadmap evidence:** Own
  `packages/rfmedia-cli/CHANGELOG.md`, `ROADMAP.md`, and `docs/roadmap-archive.md`. Record #203 only
  after implementation and real PR facts exist. Keep #204, #205, #206, and #219 open and do not
  imply their provider federation, cache, cascade, or configurable-policy scope shipped.
- **T26 — Integrated verification (no owned files):** Run focused new tests first, then the
  existing package suite and repository gates. Failures return to the task owning the implicated
  file; T26 is not a broad cleanup task.

T23 and T24 may run in parallel after T19. T25 follows final implementation/PR evidence. T26 follows
T21–T25 and T22.

## Task Granularity

- Keep source/test pairs together at trust boundaries: Last.fm transport, scheduler, facade,
  selection, action, producer, and executor. Each pair should use representative contract fixtures,
  not combinatorial matrices.
- The three-file exceptions are deliberate compile-safe units: facade plus typed mock, plan types
  plus parser/tests, apply target/resource contracts, and command factory plus parent/test.
- Serialize repeated ownership: T10 before T18 for `discover.ts`; T11 before T19 for command
  files; T12 before T13 for plan registry work. Do not assign these phases concurrently.
- Keep Bash/Zsh/Fish implementations in one task because they are one public contract. Keep the
  shared parity spec separate and run it only after all three templates are final.
- Do not edit generated sources, create a provider registry/cache, introduce direct MusicBrainz
  calls, or add a second apply engine. Those would enlarge file ownership while consuming later
  issues.
- Keep plan/apply tests contract-focused: one sealed round trip/tamper case, one satisfied/drift
  case, one known success, one lost-response reconciliation, one uncertainty/stop-admission case,
  one history/claim failure, and one no-deferred-executor assertion. Existing tests already cover
  the generic approval, artifact, and multi-operation matrices.
- Use one full-library read where the existing facade requires it; do not add paging assumptions or
  the mutation `maxBatch` limit to the unpaged artist read.

## Dependency Analysis

```text
T00 -> T01 -> T03 --------------------┐
   \-> T02 -----> T03                ├-> T10 -> T11 -----------------------┐
T01 -----------> T04 ----------------┘                                     │
T00 -> T05 -> T07 -> T08 --------------------------------------------------┤
        \-> T09 ---------------------------┐                                │
T00 -> T06 -> T07                          │                                │
T01 -> T12 -> T13 -> T14 -----------------┼-> T18 -> T19 -> T20 -> T21 ---┤
                 \-> T15 -> T16 -> T17 ----┘                                │
T03 + T07 + T13 + T16 -> T22                                               │
T19 -> T23                                                                 │
T19 -> T24                                                                 ├-> T26
final PR facts -> T25 ------------------------------------------------------┘
```

Additional hard dependencies:

- T07 requires both T05 and T06; T08 requires T07.
- T10 requires T01–T04; it deliberately does not require any Lidarr facade work.
- T13 requires T07, T09, and T12; T14 requires T08, T09, and T13.
- T15 requires T13; T16 requires T15; T17 requires T15 and T16.
- T18 requires T10, T14, and T17; T19 requires T11 and T18.
- T20 waits for T19's final command grammar, and T21 waits for all three completion templates.
- T22 may run beside late presentation work once its four production owners exist.
- T26 starts only after source, generated-contract, architecture, completions, docs, and roadmap
  tasks converge.

Recommended T26 evidence, without redundant new tests:

1. Run the focused Vitest files owned by T02–T22.
2. Run `npm run build:common` when the worktree has not built `@rfmedia/common`.
3. Run `npm run codegen:lidarr:check --workspace packages/rfmedia-cli` and
   `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`; never run the upstream refresh
   merely to verify this change.
4. Run the repository architecture suite, including the direct-import/fetch/mutation scanner.
5. Run `npm run test:run`, `npm run test:coverage`, `npm run typecheck`, `npm run build:all`, and
   `npm run lint`, plus formatter/markdown checks and `git diff --check`.
6. Generate Bash, Zsh, and Fish completions and run their exact parity spec.
7. Run `graphify update .` after code changes, then use the normal pre-push/CI gates without
   bypassing hooks.

## File-to-Task Mapping

| Task | Exclusive file ownership                                                          |
| ---- | --------------------------------------------------------------------------------- |
| T01  | `src/types/discovery.ts`; `src/types/index.ts`                                    |
| T02  | `src/types/config.ts`; `src/lib/config.ts`; `src/lib/config.test.ts`              |
| T03  | new `src/lib/discovery/lastfm.ts` and test                                        |
| T04  | `src/lib/lidarr/scheduler.ts` and test                                            |
| T05  | `src/types/lidarr.ts`; `src/lib/lidarr/types.ts` and test                         |
| T06  | generator script/test; `src/lib/lidarr/generated-contract.test.ts`                |
| T07  | `src/lib/lidarr/client.ts` and test; typed Lidarr client mock                     |
| T08  | `src/lib/lidarr/resilience.ts` and test                                           |
| T09  | `src/lib/lidarr/artist-selection.ts` and test                                     |
| T10  | new action `discover.ts` and test                                                 |
| T11  | new command `lidarr-discover.ts`; `commands/lidarr.ts`; `commands/lidarr.test.ts` |
| T12  | `src/types/lidarr-plan.ts`; `src/lib/lidarr/plan-engine.ts` and test              |
| T13  | `src/lib/lidarr/plan-operation-definitions.ts`; new focused operation test        |
| T14  | new action `plan-artist-add.ts` and test                                          |
| T15  | `apply-target-types.ts`; `apply-resources.ts`; new focused resource test          |
| T16  | new artist-add executor and test; `apply-entry-execution.ts`                      |
| T17  | `apply.ts` and `apply.test.ts`                                                    |
| T18  | `discover.ts` and test (second serial pass); action barrel                        |
| T19  | `lidarr-discover.ts`; mutation presenter; `lidarr.test.ts` (second serial pass)   |
| T20  | Bash, Zsh, and Fish completion templates                                          |
| T21  | completion parity spec                                                            |
| T22  | architecture scanner and scanner test                                             |
| T23  | discovery, plan/apply, and execution-lane feature guides                          |
| T24  | example config; package README; docs index                                        |
| T25  | package changelog; active ROADMAP; roadmap archive                                |
| T26  | validation only; no persistent ownership                                          |

All abbreviated `src/...`, `scripts/...`, and package-doc paths in this table are relative to
`packages/rfmedia-cli/`; `rfmedia.example.yaml`, `ROADMAP.md`, and `docs/...` are repository-root
paths.
